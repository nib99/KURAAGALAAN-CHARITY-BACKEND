const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const Donation = require('../models/donation');
const { 
    initializeChapa, 
    initializeStripe, 
    initializeTelebirr, 
    generateBankTransferDetails,
    verifyPayment 
} = require('../services/paymentService');
const { 
    sendDonationConfirmation, 
    sendDonationNotificationToAdmin 
} = require('../services/emailService');
const { protect, admin } = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');
const xss = require('xss');

const router = express.Router();

// Rate limiting for donations
const donationLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 donations per minute per IP
    message: {
        success: false,
        error: 'Too many donation attempts. Please wait a moment before trying again.'
    }
});

// Validation rules
const donationValidation = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters')
        .matches(/^[a-zA-Z\s\u1200-\u137F]+$/)
        .withMessage('Name can only contain letters and spaces'),
    
    body('email')
        .optional({ checkFalsy: true })
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    
    body('phone')
        .optional({ checkFalsy: true })
        .matches(/^(\+251|0)?[79]\d{8}$/)
        .withMessage('Please provide a valid Ethiopian phone number'),
    
    body('amount')
        .isFloat({ min: 1, max: 1000000 })
        .withMessage('Amount must be between 1 and 1,000,000'),
    
    body('currency')
        .isIn(['ETB', 'USD', 'EUR', 'SAR'])
        .withMessage('Currency must be ETB, USD, EUR, or SAR'),
    
    body('method')
        .isIn(['chapa', 'stripe', 'telebirr', 'manual'])
        .withMessage('Payment method must be chapa, stripe, telebirr, or manual'),
    
    body('message')
        .optional({ checkFalsy: true })
        .isLength({ max: 500 })
        .withMessage('Message cannot exceed 500 characters'),
    
    body('anonymous')
        .optional()
        .isBoolean()
        .withMessage('Anonymous must be true or false')
];

// Currency conversion rates (should be updated regularly)
const exchangeRates = {
    'USD': 55.50, // 1 USD = 55.50 ETB
    'EUR': 60.25, // 1 EUR = 60.25 ETB
    'SAR': 14.80, // 1 SAR = 14.80 ETB
    'ETB': 1.00   // 1 ETB = 1.00 ETB
};

// Convert amount to ETB for reporting
const convertToETB = (amount, currency) => {
    return parseFloat((amount * exchangeRates[currency]).toFixed(2));
};

// @desc    Process new donation
// @route   POST /api/donate
// @access  Public
router.post('/', donationLimiter, donationValidation, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { 
        name, 
        email, 
        phone, 
        amount, 
        currency, 
        method, 
        message, 
        anonymous 
    } = req.body;

    // Sanitize inputs
    const sanitizedData = {
        name: xss(name.trim()),
        email: email ? xss(email.trim()) : null,
        phone: phone ? xss(phone.trim()) : null,
        amount: parseFloat(amount),
        currency: currency.toUpperCase(),
        method: method.toLowerCase(),
        message: message ? xss(message.trim()) : null,
        anonymous: anonymous === true,
        ip_address: req.ip,
        user_agent: req.get('User-Agent'),
        referer: req.get('Referer')
    };

    // Convert amount to ETB
    sanitizedData.amount_etb = convertToETB(sanitizedData.amount, sanitizedData.currency);

    try {
        // Create donation record
        const donation = await Donation.create(sanitizedData);

        logger.payment('donation_created', {
            donationId: donation.id,
            amount: `${sanitizedData.amount} ${sanitizedData.currency}`,
            method: sanitizedData.method,
            donor: sanitizedData.anonymous ? 'Anonymous' : sanitizedData.name
        });

        let paymentResponse;

        // Process payment based on method
        switch (sanitizedData.method) {
            case 'chapa':
                paymentResponse = await initializeChapa(donation, req);
                break;
            case 'stripe':
                paymentResponse = await initializeStripe(donation, req);
                break;
            case 'telebirr':
                paymentResponse = await initializeTelebirr(donation, req);
                break;
            case 'manual':
                paymentResponse = await generateBankTransferDetails(donation);
                break;
            default:
                throw new Error('Unsupported payment method');
        }

        // Update donation with payment details
        await donation.update({
            transaction_id: paymentResponse.transaction_id,
            payment_reference: paymentResponse.reference,
            payment_data: JSON.stringify(paymentResponse)
        });

        // Send confirmation email if email provided
        if (sanitizedData.email) {
            try {
                await sendDonationConfirmation(sanitizedData.email, donation, paymentResponse);
            } catch (emailError) {
                logger.error('Failed to send donation confirmation email:', emailError);
                // Don't fail the donation if email fails
            }
        }

        // Send admin notification
        try {
            await sendDonationNotificationToAdmin(donation, paymentResponse);
        } catch (emailError) {
            logger.error('Failed to send admin notification:', emailError);
        }

        res.status(201).json({
            success: true,
            message: 'Donation initiated successfully',
            donation_id: donation.id,
            amount: `${sanitizedData.amount} ${sanitizedData.currency}`,
            method: sanitizedData.method,
            status: donation.status,
            ...paymentResponse
        });

    } catch (error) {
        logger.error('Donation processing failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process donation',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Get donation status
// @route   GET /api/donate/:id
// @access  Public
router.get('/:id', asyncHandler(async (req, res) => {
    const { id } = req.params;

    const donation = await Donation.findByPk(id, {
        attributes: [
            'id', 'name', 'amount', 'currency', 'method', 
            'status', 'message', 'anonymous', 'created_at'
        ]
    });

    if (!donation) {
        return res.status(404).json({
            success: false,
            error: 'Donation not found'
        });
    }

    res.json({
        success: true,
        donation: {
            id: donation.id,
            donor_name: donation.getDonorName(),
            amount: donation.getDisplayAmount(),
            method: donation.method,
            status: donation.status,
            message: donation.message,
            date: donation.created_at
        }
    });
}));

// @desc    List donations with filters and pagination
// @route   GET /api/donate
// @access  Private (Admin)
router.get('/', protect, admin, asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 20,
        status,
        method,
        currency,
        start_date,
        end_date,
        search
    } = req.query;

    const offset = (page - 1) * limit;
    const where = {};

    // Apply filters
    if (status) where.status = status;
    if (method) where.method = method;
    if (currency) where.currency = currency;
    
    if (start_date && end_date) {
        where.created_at = {
            [Op.between]: [new Date(start_date), new Date(end_date)]
        };
    }

    if (search) {
        where[Op.or] = [
            { name: { [Op.like]: `%${search}%` } },
            { email: { [Op.like]: `%${search}%` } },
            { id: { [Op.like]: `%${search}%` } }
        ];
    }

    const { count, rows: donations } = await Donation.findAndCountAll({
        where,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['created_at', 'DESC']]
    });

    res.json({
        success: true,
        donations,
        pagination: {
            current_page: parseInt(page),
            total_pages: Math.ceil(count / limit),
            total_items: count,
            items_per_page: parseInt(limit)
        }
    });
}));

// @desc    Verify payment status
// @route   POST /api/donate/:id/verify
// @access  Private (Admin)
router.post('/:id/verify', protect, admin, asyncHandler(async (req, res) => {
    const { id } = req.params;

    const donation = await Donation.findByPk(id);
    if (!donation) {
        return res.status(404).json({
            success: false,
            error: 'Donation not found'
        });
    }

    try {
        const verificationResult = await verifyPayment(donation);
        
        // Update donation status based on verification
        if (verificationResult.status === 'completed') {
            await donation.update({
                status: 'completed',
                verified_at: new Date(),
                verified_by: req.user.id
            });
        } else if (verificationResult.status === 'failed') {
            await donation.update({
                status: 'failed',
                error_message: verificationResult.message || 'Payment verification failed'
            });
        }

        logger.payment('payment_verified', {
            donationId: donation.id,
            status: verificationResult.status,
            verifiedBy: req.user.email
        });

        res.json({
            success: true,
            message: 'Payment verification completed',
            status: verificationResult.status,
            donation: {
                id: donation.id,
                status: donation.status,
                verified_at: donation.verified_at
            }
        });

    } catch (error) {
        logger.error('Payment verification failed:', error);
        res.status(500).json({
            success: false,
            error: 'Payment verification failed',
            message: error.message
        });
    }
}));

// @desc    Update donation status
// @route   PUT /api/donate/:id/status
// @access  Private (Admin)
router.put('/:id/status', protect, admin, [
    body('status')
        .isIn(['pending', 'completed', 'failed', 'refunded', 'cancelled'])
        .withMessage('Invalid status'),
    body('admin_notes')
        .optional()
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

    const donation = await Donation.findByPk(id);
    if (!donation) {
        return res.status(404).json({
            success: false,
            error: 'Donation not found'
        });
    }

    const oldStatus = donation.status;
    
    await donation.update({
        status,
        admin_notes: admin_notes || donation.admin_notes,
        updated_by: req.user.id
    });

    logger.payment('donation_status_updated', {
        donationId: donation.id,
        oldStatus,
        newStatus: status,
        updatedBy: req.user.email
    });

    res.json({
        success: true,
        message: 'Donation status updated successfully',
        donation: {
            id: donation.id,
            status: donation.status,
            admin_notes: donation.admin_notes,
            updated_at: donation.updated_at
        }
    });
}));

module.exports = router;
