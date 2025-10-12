// routes/donate.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

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
    .isIn(['chapa', 'stripe', 'telebirr', 'manual', 'bank_transfer']) // Added bank_transfer
    .withMessage('Payment method must be chapa, stripe, telebirr, manual, or bank_transfer'),
  body('message')
    .optional({ checkFalsy: true })
    .isLength({ max: 500 })
    .withMessage('Message cannot exceed 500 characters'),
  body('anonymous')
    .optional()
    .isBoolean()
    .withMessage('Anonymous must be true or false')
];

// @route   POST /api/donations/create
// @desc    Create a new donation
// @access  Public
router.post('/create', donationValidation, async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { name, email, phone, amount, currency, method, message, anonymous } = req.body;

    // Simplified exchange rates (ETB base)
    const exchangeRates = {
      USD: 55.5,
      EUR: 60.25,
      SAR: 14.8,
      ETB: 1.0,
    };

    const convertToETB = (amount, currency) =>
      parseFloat((amount * exchangeRates[currency]).toFixed(2));

    // Donation object
    const donation = {
      id: 'donation_' + Date.now(),
      name: anonymous ? 'Anonymous' : name,
      email: email || null,
      phone: phone || null,
      amount: parseFloat(amount),
      currency,
      amount_etb: convertToETB(amount, currency),
      method,
      message: message || null,
      anonymous: anonymous || false,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    // Payment processing
    switch (method) {
      case 'manual':
      case 'bank_transfer':
        return res.json({
          success: true,
          type: 'manual',
          message: 'Bank transfer donation recorded successfully.',
          donation_id: donation.id,
          bankDetails: {
            accountName: 'Kuraa Galaan Charity Organization', // Fixed typo
            accountNumber: '1000449482167',
            bankName: 'Commercial Bank of Ethiopia',
            branch: 'Bole Branch',
            swiftCode: 'CBETETAA',
            instructions: 'Please transfer the amount and send the transaction receipt to kuraagalaan2024@gmail.com with your donation ID.',
          },
        });

      case 'chapa':
        return res.json({
          success: true,
          type: 'redirect',
          message: 'Redirect to Chapa payment',
          donation_id: donation.id,
          payment_url: 'https://chapa.co/pay/example-link', // Replace with real Chapa API
        });

      case 'telebirr':
        return res.json({
          success: true,
          type: 'redirect',
          message: 'Telebirr payment initialized',
          donation_id: donation.id,
          payment_url: 'https://telebirr.et/pay/example-transaction',
        });

      case 'paypal':
        return res.json({
          success: true,
          type: 'redirect',
          message: 'Redirect to PayPal donation page',
          donation_id: donation.id,
          payment_url: 'https://paypal.com/donate/example',
        });

      case 'stripe':
        return res.json({
          success: true,
          type: 'redirect',
          message: 'Redirect to Stripe Checkout',
          donation_id: donation.id,
          payment_url: 'https://checkout.stripe.com/pay/example',
        });

      default:
        return res.status(400).json({
          success: false,
          message: 'Unsupported payment method',
        });
    }
  } catch (error) {
    console.error('Create donation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing donation',
    });
  }
});

// @route   GET /api/donations/history
router.get('/history', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Donation history endpoint working',
      data: [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error while fetching donation history',
    });
  }
});

// @route   GET /api/donations/stats
router.get('/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Donation stats endpoint working',
      data: {
        totalDonations: 0,
        totalAmount: 0,
        donorCount: 0,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error while fetching donation stats',
    });
  }
});

// @route   POST /api/donations/verify
router.post('/verify', async (req, res) => {
  try {
    const { donation_id, payment_id } = req.body;

    res.json({
      success: true,
      message: 'Payment verification endpoint working',
      data: {
        donation_id,
        payment_id,
        status: 'verified',
      },
    });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while verifying payment',
    });
  }
});

module.exports = router;
