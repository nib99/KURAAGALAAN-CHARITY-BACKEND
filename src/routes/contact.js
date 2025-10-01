const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { Op } = require('sequelize');
const Contact = require('../models/Contact');
const ContactReply = require('../models/ContactReply');
const User = require('../models/User');
const { protect, admin } = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { 
    sendContactConfirmation, 
    sendContactNotificationToAdmin,
    sendContactReply 
} = require('../services/emailService');
const logger = require('../utils/logger');
const xss = require('xss');

const router = express.Router();

// Rate limiting for contact form
const contactLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 3, // 3 messages per minute per IP
    message: {
        success: false,
        error: 'Too many messages submitted. Please wait a moment before sending another message.'
    }
});

// Contact subjects with descriptions
const contactSubjects = {
    'volunteer': {
        name: 'Volunteer Opportunities',
        description: 'Join our volunteer community and make a difference',
        priority: 'medium'
    },
    'partnership': {
        name: 'Partnership & Collaboration',
        description: 'Explore partnership opportunities with our organization',
        priority: 'high'
    },
    'donation': {
        name: 'Donation Information',
        description: 'Questions about donations, tax receipts, and giving options',
        priority: 'medium'
    },
    'general': {
        name: 'General Inquiry',
        description: 'General questions about our work and programs',
        priority: 'medium'
    },
    'support': {
        name: 'Technical Support',
        description: 'Website issues, account problems, or technical assistance',
        priority: 'high'
    },
    'media': {
        name: 'Media & Press',
        description: 'Media inquiries, interviews, and press-related questions',
        priority: 'high'
    },
    'other': {
        name: 'Other',
        description: 'Any other questions or concerns not covered above',
        priority: 'low'
    }
};

// Validation rules
const contactValidation = [
    body('first_name')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('First name must be between 2 and 50 characters')
        .matches(/^[a-zA-Z\s\u1200-\u137F]+$/)
        .withMessage('First name can only contain letters and spaces'),
    
    body('last_name')
        .trim()
        .isLength({ min: 2, max: 50 })
        .withMessage('Last name must be between 2 and 50 characters')
        .matches(/^[a-zA-Z\s\u1200-\u137F]+$/)
        .withMessage('Last name can only contain letters and spaces'),
    
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    
    body('phone')
        .optional({ checkFalsy: true })
        .matches(/^(\+251|0)?[79]\d{8}$/)
        .withMessage('Please provide a valid Ethiopian phone number'),
    
    body('subject')
        .isIn(Object.keys(contactSubjects))
        .withMessage('Please select a valid subject'),
    
    body('message')
        .trim()
        .isLength({ min: 10, max: 2000 })
        .withMessage('Message must be between 10 and 2000 characters'),
    
    body('organization')
        .optional({ checkFalsy: true })
        .isLength({ max: 200 })
        .withMessage('Organization name cannot exceed 200 characters'),
    
    body('preferred_contact')
        .optional()
        .isIn(['email', 'phone', 'either'])
        .withMessage('Preferred contact method must be email, phone, or either')
];

// @desc    Get contact subjects
// @route   GET /api/contact/subjects
// @access  Public
router.get('/subjects', (req, res) => {
    res.json({
        success: true,
        subjects: contactSubjects
    });
});

// @desc    Submit contact message
// @route   POST /api/contact
// @access  Public
router.post('/', contactLimiter, contactValidation, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const {
        first_name,
        last_name,
        email,
        phone,
        subject,
        message,
        organization,
        preferred_contact
    } = req.body;

    // Sanitize inputs
    const sanitizedData = {
        first_name: xss(first_name.trim()),
        last_name: xss(last_name.trim()),
        full_name: `${xss(first_name.trim())} ${xss(last_name.trim())}`,
        email: email.toLowerCase(),
        phone: phone ? xss(phone.trim()) : null,
        subject,
        subject_category: contactSubjects[subject].name,
        message: xss(message.trim()),
        organization: organization ? xss(organization.trim()) : null,
        preferred_contact: preferred_contact || 'email',
        priority: contactSubjects[subject].priority,
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
        referer: req.get('Referer')
    };

    try {
        // Create contact message
        const contact = await Contact.create(sanitizedData);

        logger.info(`New contact message received from ${contact.email}`, {
            contactId: contact.id,
            subject: contact.subject,
            priority: contact.priority
        });

        // Send confirmation email to sender
        try {
            await sendContactConfirmation(contact, contactSubjects[subject]);
        } catch (emailError) {
            logger.error('Failed to send contact confirmation:', emailError);
            // Don't fail the contact submission if email fails
        }

        // Send notification to admin
        try {
            await sendContactNotificationToAdmin(contact);
        } catch (emailError) {
            logger.error('Failed to send admin notification:', emailError);
        }

        res.status(201).json({
            success: true,
            message: 'Your message has been sent successfully! We will respond as soon as possible.',
            contact: {
                id: contact.id,
                subject: contact.subject_category,
                priority: contact.priority,
                status: contact.status,
                submitted_at: contact.created_at
            }
        });

    } catch (error) {
        logger.error('Contact message submission failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send message',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Get contact message by ID
// @route   GET /api/contact/:id
// @access  Private (Admin)
router.get('/:id', protect, admin, asyncHandler(async (req, res) => {
    const { id } = req.params;

    const contact = await Contact.findByPk(id, {
        include: [
            {
                model: ContactReply,
                as: 'replies',
                include: [
                    {
                        model: User,
                        as: 'replier',
                        attributes: ['id', 'name', 'email']
                    }
                ],
                order: [['replied_at', 'ASC']]
            }
        ]
    });

    if (!contact) {
        return res.status(404).json({
            success: false,
            error: 'Contact message not found'
        });
    }

    // Mark as read if not already read
    if (contact.status === 'new') {
        await contact.update({
            status: 'read',
            read_at: new Date(),
            read_by: req.user.id
        });
    }

    res.json({
        success: true,
        contact
    });
}));

// @desc    List contact messages with filters and pagination
// @route   GET /api/contact
// @access  Private (Admin)
router.get('/', protect, admin, asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 20,
        status,
        subject,
        priority,
        start_date,
        end_date,
        search
    } = req.query;

    const offset = (page - 1) * limit;
    const where = {};

    // Apply filters
    if (status) where.status = status;
    if (subject) where.subject = subject;
    if (priority) where.priority = priority;
    
    if (start_date && end_date) {
        where.created_at = {
            [Op.between]: [new Date(start_date), new Date(end_date)]
        };
    }

    if (search) {
        where[Op.or] = [
            { full_name: { [Op.like]: `%${search}%` } },
            { email: { [Op.like]: `%${search}%` } },
            { organization: { [Op.like]: `%${search}%` } },
            { message: { [Op.like]: `%${search}%` } }
        ];
    }

    const { count, rows: contacts } = await Contact.findAndCountAll({
        where,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [
            ['priority', 'DESC'], // Urgent first
            ['created_at', 'DESC'] // Newest first
        ],
        include: [
            {
                model: ContactReply,
                as: 'replies',
                attributes: ['id', 'replied_at'],
                limit: 1,
                order: [['replied_at', 'DESC']]
            }
        ]
    });

    // Get summary statistics
    const stats = await Contact.findAll({
        attributes: [
            'status',
            [Contact.sequelize.fn('COUNT', Contact.sequelize.col('id')), 'count']
        ],
        group: ['status'],
        raw: true
    });

    const statusCounts = stats.reduce((acc, stat) => {
        acc[stat.status] = parseInt(stat.count);
        return acc;
    }, {});

    res.json({
        success: true,
        contacts,
        pagination: {
            current_page: parseInt(page),
            total_pages: Math.ceil(count / limit),
            total_items: count,
            items_per_page: parseInt(limit)
        },
        statistics: {
            total: count,
            by_status: statusCounts
        }
    });
}));

// @desc    Reply to contact message
// @route   POST /api/contact/:id/reply
// @access  Private (Admin)
router.post('/:id/reply', protect, admin, [
    body('message')
        .trim()
        .isLength({ min: 10, max: 2000 })
        .withMessage('Reply message must be between 10 and 2000 characters'),
    
    body('internal_notes')
        .optional({ checkFalsy: true })
        .isLength({ max: 1000 })
        .withMessage('Internal notes cannot exceed 1000 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { id } = req.params;
    const { message, internal_notes } = req.body;

    try {
        const contact = await Contact.findByPk(id);
        if (!contact) {
            return res.status(404).json({
                success: false,
                error: 'Contact message not found'
            });
        }

        // Create reply
        const reply = await ContactReply.create({
            contact_id: contact.id,
            message: xss(message.trim()),
            internal_notes: internal_notes ? xss(internal_notes.trim()) : null,
            replied_by: req.user.id,
            replied_at: new Date()
        });

        // Update contact status
        await contact.update({
            status: 'replied',
            replied_at: new Date(),
            replied_by: req.user.id,
            last_reply_at: new Date()
        });

        // Send reply email to contact
        try {
            const admin = await User.findByPk(req.user.id, {
                attributes: ['name', 'email']
            });
            await sendContactReply(contact, reply, admin);
        } catch (emailError) {
            logger.error('Failed to send contact reply email:', emailError);
            // Don't fail the reply if email fails
        }

        logger.info(`Contact reply sent by ${req.user.email}`, {
            contactId: contact.id,
            replyId: reply.id,
            adminId: req.user.id
        });

        res.status(201).json({
            success: true,
            message: 'Reply sent successfully',
            reply: {
                id: reply.id,
                message: reply.message,
                replied_at: reply.replied_at,
                replied_by: req.user.name
            }
        });

    } catch (error) {
        logger.error('Contact reply failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to send reply',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Update contact message status
// @route   PUT /api/contact/:id/status
// @access  Private (Admin)
router.put('/:id/status', protect, admin, [
    body('status')
        .isIn(['new', 'read', 'in_progress', 'replied', 'resolved', 'closed'])
        .withMessage('Invalid status'),
    
    body('admin_notes')
        .optional({ checkFalsy: true })
        .isLength({ max: 1000 })
        .withMessage('Admin notes cannot exceed 1000 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { id } = req.params;
    const { status, admin_notes } = req.body;

    try {
        const contact = await Contact.findByPk(id);
        if (!contact) {
            return res.status(404).json({
                success: false,
                error: 'Contact message not found'
            });
        }

        const oldStatus = contact.status;
        const updateData = {
            status,
            updated_by: req.user.id
        };

        // Set status-specific timestamps
        if (status === 'resolved' && oldStatus !== 'resolved') {
            updateData.resolved_at = new Date();
        }
        if (status === 'closed' && oldStatus !== 'closed') {
            updateData.closed_at = new Date();
        }
        if (admin_notes) {
            updateData.admin_notes = xss(admin_notes.trim());
        }

        await contact.update(updateData);

        logger.info(`Contact status updated by ${req.user.email}`, {
            contactId: contact.id,
            oldStatus,
            newStatus: status,
            adminId: req.user.id
        });

        res.json({
            success: true,
            message: 'Contact status updated successfully',
            contact: {
                id: contact.id,
                status: contact.status,
                admin_notes: contact.admin_notes,
                updated_at: contact.updated_at
            }
        });

    } catch (error) {
        logger.error('Contact status update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update status',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Update contact message priority
// @route   PUT /api/contact/:id/priority
// @access  Private (Admin)
router.put('/:id/priority', protect, admin, [
    body('priority')
        .isIn(['low', 'medium', 'high', 'urgent'])
        .withMessage('Priority must be low, medium, high, or urgent')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { id } = req.params;
    const { priority } = req.body;

    try {
        const contact = await Contact.findByPk(id);
        if (!contact) {
            return res.status(404).json({
                success: false,
                error: 'Contact message not found'
            });
        }

        const oldPriority = contact.priority;
        
        await contact.update({
            priority,
            updated_by: req.user.id
        });

        logger.info(`Contact priority updated by ${req.user.email}`, {
            contactId: contact.id,
            oldPriority,
            newPriority: priority,
            adminId: req.user.id
        });

        res.json({
            success: true,
            message: 'Contact priority updated successfully',
            contact: {
                id: contact.id,
                priority: contact.priority,
                updated_at: contact.updated_at
            }
        });

    } catch (error) {
        logger.error('Contact priority update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update priority',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

module.exports = router;
