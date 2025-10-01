
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { protect, admin } = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../services/emailService');
const logger = require('../utils/logger');
const xss = require('xss');

const router = express.Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: {
        success: false,
        error: 'Too many authentication attempts. Please try again later.'
    }
});

const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 password reset attempts per hour
    message: {
        success: false,
        error: 'Too many password reset attempts. Please try again later.'
    }
});

// Generate JWT token
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '30d'
    });
};

// Validation rules
const registerValidation = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters')
        .matches(/^[a-zA-Z\s\u1200-\u137F]+$/)
        .withMessage('Name can only contain letters and spaces'),
    
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character'),
    
    body('phone')
        .optional({ checkFalsy: true })
        .matches(/^(\+251|0)?[79]\d{8}$/)
        .withMessage('Please provide a valid Ethiopian phone number'),
    
    body('organization')
        .optional({ checkFalsy: true })
        .isLength({ max: 200 })
        .withMessage('Organization name cannot exceed 200 characters')
];

const loginValidation = [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    
    body('password')
        .notEmpty()
        .withMessage('Password is required')
];

// @desc    Register new user
// @route   POST /api/users/register
// @access  Public
router.post('/register', authLimiter, registerValidation, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { name, email, password, phone, organization } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
        return res.status(400).json({
            success: false,
            error: 'User already exists with this email address'
        });
    }

    // Hash password
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate email verification token
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    try {
        // Create user
        const user = await User.create({
            name: xss(name.trim()),
            email: email.toLowerCase(),
            password: hashedPassword,
            phone: phone ? xss(phone.trim()) : null,
            organization: organization ? xss(organization.trim()) : null,
            email_verification_token: emailVerificationToken,
            email_verification_expires: emailVerificationExpires,
            registration_ip: req.ip
        });

        // Send welcome email with verification link
        try {
            await sendWelcomeEmail(user, emailVerificationToken);
        } catch (emailError) {
            logger.error('Failed to send welcome email:', emailError);
            // Don't fail registration if email fails
        }

        logger.info(`New user registered: ${user.email}`, {
            userId: user.id,
            name: user.name,
            ip: req.ip
        });

        res.status(201).json({
            success: true,
            message: 'Registration successful! Please check your email to verify your account.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                email_verified: user.email_verified
            }
        });

    } catch (error) {
        logger.error('User registration failed:', error);
        res.status(500).json({
            success: false,
            error: 'Registration failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Login user
// @route   POST /api/users/login
// @access  Public
router.post('/login', authLimiter, loginValidation, asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { email, password } = req.body;

    try {
        // Find user and include password for comparison
        const user = await User.findOne({ 
            where: { email: email.toLowerCase() },
            attributes: ['id', 'name', 'email', 'password', 'role', 'is_active', 'email_verified', 'login_attempts', 'lock_until']
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                error: 'Invalid email or password'
            });
        }

        // Check if account is locked
        if (user.lock_until && user.lock_until > new Date()) {
            const lockTimeRemaining = Math.ceil((user.lock_until - new Date()) / (1000 * 60));
            return res.status(423).json({
                success: false,
                error: `Account is temporarily locked. Try again in ${lockTimeRemaining} minutes.`
            });
        }

        // Check if account is active
        if (!user.is_active) {
            return res.status(401).json({
                success: false,
                error: 'Account is deactivated. Please contact support.'
            });
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
            // Increment login attempts
            const loginAttempts = (user.login_attempts || 0) + 1;
            const updateData = {
                login_attempts: loginAttempts,
                last_failed_login: new Date(),
                last_failed_login_ip: req.ip
            };

            // Lock account after 5 failed attempts
            if (loginAttempts >= 5) {
                updateData.lock_until = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
                logger.security('account_locked', {
                    userId: user.id,
                    email: user.email,
                    ip: req.ip,
                    attempts: loginAttempts
                });
            }

            await user.update(updateData);

            return res.status(401).json({
                success: false,
                error: 'Invalid email or password',
                attempts_remaining: Math.max(0, 5 - loginAttempts)
            });
        }

        // Reset login attempts on successful login
        await user.update({
            login_attempts: 0,
            lock_until: null,
            last_login: new Date(),
            last_login_ip: req.ip,
            login_count: (user.login_count || 0) + 1
        });

        // Generate JWT token
        const token = generateToken(user.id);

        logger.info(`User logged in: ${user.email}`, {
            userId: user.id,
            ip: req.ip
        });

        res.json({
            success: true,
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                email_verified: user.email_verified,
                last_login: user.last_login
            }
        });

    } catch (error) {
        logger.error('Login failed:', error);
        res.status(500).json({
            success: false,
            error: 'Login failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Verify email address
// @route   POST /api/users/verify-email
// @access  Public
router.post('/verify-email', [
    body('token')
        .notEmpty()
        .withMessage('Verification token is required')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { token } = req.body;

    try {
        const user = await User.findOne({
            where: {
                email_verification_token: token,
                email_verification_expires: {
                    [Op.gt]: new Date()
                }
            }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired verification token'
            });
        }

        // Update user as verified
        await user.update({
            email_verified: true,
            email_verified_at: new Date(),
            email_verification_token: null,
            email_verification_expires: null
        });

        logger.info(`Email verified for user: ${user.email}`, {
            userId: user.id
        });

        res.json({
            success: true,
            message: 'Email verified successfully! You can now access all features.',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                email_verified: true
            }
        });

    } catch (error) {
        logger.error('Email verification failed:', error);
        res.status(500).json({
            success: false,
            error: 'Email verification failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Request password reset
// @route   POST /api/users/forgot-password
// @access  Public
router.post('/forgot-password', passwordResetLimiter, [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { email } = req.body;

    try {
        const user = await User.findOne({ where: { email: email.toLowerCase() } });

        // Always return success to prevent email enumeration
        if (!user) {
            return res.json({
                success: true,
                message: 'If an account with that email exists, a password reset link has been sent.'
            });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        await user.update({
            password_reset_token: resetToken,
            password_reset_expires: resetExpires
        });

        // Send password reset email
        try {
            await sendPasswordResetEmail(user, resetToken);
        } catch (emailError) {
            logger.error('Failed to send password reset email:', emailError);
            return res.status(500).json({
                success: false,
                error: 'Failed to send password reset email'
            });
        }

        logger.security('password_reset_requested', {
            userId: user.id,
            email: user.email,
            ip: req.ip
        });

        res.json({
            success: true,
            message: 'Password reset link has been sent to your email address.'
        });

    } catch (error) {
        logger.error('Password reset request failed:', error);
        res.status(500).json({
            success: false,
            error: 'Password reset request failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Reset password
// @route   POST /api/users/reset-password
// @access  Public
router.post('/reset-password', [
    body('token')
        .notEmpty()
        .withMessage('Reset token is required'),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { token, password } = req.body;

    try {
        const user = await User.findOne({
            where: {
                password_reset_token: token,
                password_reset_expires: {
                    [Op.gt]: new Date()
                }
            }
        });

        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or expired reset token'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_ROUNDS) || 12);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Update user password and clear reset token
        await user.update({
            password: hashedPassword,
            password_reset_token: null,
            password_reset_expires: null,
            password_changed_at: new Date(),
            login_attempts: 0,
            lock_until: null
        });

        logger.security('password_reset_completed', {
            userId: user.id,
            email: user.email,
            ip: req.ip
        });

        res.json({
            success: true,
            message: 'Password has been reset successfully. You can now log in with your new password.'
        });

    } catch (error) {
        logger.error('Password reset failed:', error);
        res.status(500).json({
            success: false,
            error: 'Password reset failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', protect, asyncHandler(async (req, res) => {
    const user = await User.findByPk(req.user.id, {
        attributes: [
            'id', 'name', 'email', 'phone', 'organization', 'role', 
            'is_active', 'email_verified', 'created_at', 'last_login'
        ]
    });

    if (!user) {
        return res.status(404).json({
            success: false,
            error: 'User not found'
        });
    }

    res.json({
        success: true,
        user
    });
}));

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', protect, [
    body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
    
    body('phone')
        .optional({ checkFalsy: true })
        .matches(/^(\+251|0)?[79]\d{8}$/)
        .withMessage('Please provide a valid Ethiopian phone number'),
    
    body('organization')
        .optional({ checkFalsy: true })
        .isLength({ max: 200 })
        .withMessage('Organization name cannot exceed 200 characters')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { name, phone, organization } = req.body;

    try {
        const user = await User.findByPk(req.user.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        const updateData = {};
        if (name) updateData.name = xss(name.trim());
        if (phone !== undefined) updateData.phone = phone ? xss(phone.trim()) : null;
        if (organization !== undefined) updateData.organization = organization ? xss(organization.trim()) : null;

        await user.update(updateData);

        logger.info(`User profile updated: ${user.email}`, {
            userId: user.id,
            changes: Object.keys(updateData)
        });

        res.json({
            success: true,
            message: 'Profile updated successfully',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                organization: user.organization,
                updated_at: user.updated_at
            }
        });

    } catch (error) {
        logger.error('Profile update failed:', error);
        res.status(500).json({
            success: false,
            error: 'Profile update failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

// @desc    Change password
// @route   POST /api/users/change-password
// @access  Private
router.post('/change-password', protect, [
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
        .withMessage('New password must contain at least one uppercase letter, one lowercase letter, one number, and one special character')
], asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            error: 'Validation failed',
            details: errors.array()
        });
    }

    const { currentPassword, newPassword } = req.body;

    try {
        const user = await User.findByPk(req.user.id, {
            attributes: ['id', 'email', 'password']
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
        if (!isCurrentPasswordValid) {
            return res.status(400).json({
                success: false,
                error: 'Current password is incorrect'
            });
        }

        // Check if new password is different from current
        const isSamePassword = await bcrypt.compare(newPassword, user.password);
        if (isSamePassword) {
            return res.status(400).json({
                success: false,
                error: 'New password must be different from current password'
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_ROUNDS) || 12);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // Update password
        await user.update({
            password: hashedPassword,
            password_changed_at: new Date()
        });

        logger.security('password_changed', {
            userId: user.id,
            email: user.email,
            ip: req.ip
        });

        res.json({
            success: true,
            message: 'Password changed successfully'
        });

    } catch (error) {
        logger.error('Password change failed:', error);
        res.status(500).json({
            success: false,
            error: 'Password change failed',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
        });
    }
}));

module.exports = router;
