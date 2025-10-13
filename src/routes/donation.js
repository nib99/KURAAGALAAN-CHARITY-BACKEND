const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode'); // For optional QR code generation in bank transfer
const crypto = require('crypto'); // For hashing and signatures
const Stripe = require('stripe'); // For Stripe integration
require('dotenv').config();

// Initialize Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Validation rules for donation input
const donationValidation = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s\u1200-\u137F-]+$/)
    .withMessage('Name can only contain letters, spaces, and hyphens'),
  body('email')
    .optional({ checkFalsy: true })
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('phone')
    .optional({ checkFalsy: true })
    .matches(/^(\+251|0)?[79]\d{8}$/)
    .withMessage('Please provide a valid Ethiopian phone number'),
  body().custom((value, { req }) => {
    if (!req.body.anonymous && !req.body.email && !req.body.phone) {
      throw new Error('Email or phone is required for non-anonymous donations');
    }
    return true;
  }),
  body('amount')
    .isFloat({ min: 1, max: 1000000 })
    .withMessage('Amount must be between 1 and 1,000,000'),
  body('currency')
    .isIn(['ETB', 'USD', 'EUR', 'SAR'])
    .withMessage('Currency must be ETB, USD, EUR, or SAR'),
  body('method')
    .isIn(['chapa', 'stripe', 'telebirr', 'paypal', 'bank_transfer'])
    .withMessage('Payment method must be chapa, stripe, telebirr, paypal, or bank_transfer'),
  body('message')
    .optional({ checkFalsy: true })
    .isLength({ max: 500 })
    .withMessage('Message cannot exceed 500 characters'),
  body('anonymous')
    .optional()
    .isBoolean()
    .withMessage('Anonymous must be true or false'),
];

// Helper function for PayPal access token
const getPayPalAccessToken = async () => {
  try {
    const response = await axios.post(
      process.env.PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com/v1/oauth2/token' : 'https://api-m.paypal.com/v1/oauth2/token',
      'grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return response.data.access_token;
  } catch (error) {
    throw new Error('Failed to get PayPal access token: ' + error.message);
  }
};

// Helper function for Telebirr signature (SHA256 of sorted params concatenated without separators + appKey)
const generateTelebirrSign = (params, appKey) => {
  const sortedKeys = Object.keys(params).sort();
  let str = '';
  sortedKeys.forEach((key) => {
    str += key + (params[key] || '');
  });
  str += appKey;
  return crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
};

// @route   POST /api/donations/create
router.post('/create', donationValidation, async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }

    const { name, email, phone, amount, currency, method, message, anonymous } = req.body;

    // Simplified exchange rates (replace with API call in production)
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
      id: uuidv4(),
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

    // Save to database (uncomment when database is set up)
    // await Donation.create(donation);

    // Validate common environment variables
    const requiredEnvVars = ['BACKEND_URL', 'FRONTEND_URL', 'CONTACT_EMAIL'];
    const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
    if (missingEnvVars.length > 0) {
      console.error('Missing environment variables:', missingEnvVars);
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    // Payment processing
    switch (method) {
      case 'chapa':
        try {
          // Chapa-specific env validation
          if (!process.env.CHAPA_SECRET_KEY) {
            return res.status(500).json({ success: false, message: 'Chapa configuration missing' });
          }

          // Validate email for Chapa
          if (!email && !anonymous) {
            return res.status(400).json({
              success: false,
              message: 'Email is required for Chapa payments unless anonymous',
            });
          }

          const nameParts = anonymous ? ['Anonymous'] : name.trim().split(' ');
          const firstName = nameParts[0];
          const lastName = nameParts.slice(1).join(' ') || '';

          const chapaRes = await axios.post(
            'https://api.chapa.co/v1/transaction/initialize',
            {
              amount: donation.amount,
              currency: donation.currency,
              email: anonymous ? `donor-${donation.id}@example.com` : email,
              first_name: firstName,
              last_name: lastName,
              tx_ref: `kuraa-${donation.id}-${Date.now()}`,
              callback_url: `${process.env.BACKEND_URL}/api/donations/verify`,
              return_url: `${process.env.FRONTEND_URL}/donation/success?donation_id=${donation.id}`,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          if (!chapaRes.data?.data?.checkout_url) {
            throw new Error('Invalid Chapa response');
          }

          return res.json({
            success: true,
            type: 'redirect',
            donation_id: donation.id,
            message: 'Redirect to Chapa payment page',
            payment_url: chapaRes.data.data.checkout_url,
          });
        } catch (err) {
          console.error('Chapa error:', err);
          return res.status(500).json({ success: false, message: 'Failed to initialize Chapa payment' });
        }

      case 'stripe':
        try {
          if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(500).json({ success: false, message: 'Stripe configuration missing' });
          }

          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
              {
                price_data: {
                  currency: donation.currency.toLowerCase(),
                  product_data: {
                    name: 'Donation to Kuraa Galaan Charity',
                  },
                  unit_amount: donation.amount * 100, // In cents
                },
                quantity: 1,
              },
            ],
            mode: 'payment',
            success_url: `${process.env.FRONTEND_URL}/donation/success?donation_id=${donation.id}`,
            cancel_url: `${process.env.FRONTEND_URL}/donation/cancel?donation_id=${donation.id}`,
            client_reference_id: donation.id,
            customer_email: email || undefined,
          });

          return res.json({
            success: true,
            type: 'redirect',
            donation_id: donation.id,
            message: 'Redirect to Stripe Checkout',
            payment_url: session.url,
          });
        } catch (err) {
          console.error('Stripe error:', err);
          return res.status(500).json({ success: false, message: 'Failed to initialize Stripe payment' });
        }

      case 'telebirr':
        try {
          // Telebirr-specific env validation
          const telebirrVars = ['TELEBIRR_APP_ID', 'TELEBIRR_APP_KEY', 'TELEBIRR_SHORT_CODE', 'TELEBIRR_PUBLIC_KEY', 'TELEBIRR_API_URL'];
          const missingTelebirrVars = telebirrVars.filter((varName) => !process.env[varName]);
          if (missingTelebirrVars.length > 0) {
            return res.status(500).json({ success: false, message: 'Telebirr configuration missing' });
          }

          const params = {
            appId: process.env.TELEBIRR_APP_ID,
            nonce: uuidv4(),
            notifyUrl: `${process.env.BACKEND_URL}/api/donations/verify`,
            outTradeNo: `kuraa-${donation.id}`,
            receiveName: 'Kuraa Galaan Charity Organization',
            returnUrl: `${process.env.FRONTEND_URL}/donation/success?donation_id=${donation.id}`,
            shortCode: process.env.TELEBIRR_SHORT_CODE,
            subject: 'Donation',
            timeoutExpress: '30',
            timestamp: Date.now().toString(),
            totalAmount: donation.amount.toFixed(2),
          };

          params.sign = generateTelebirrSign(params, process.env.TELEBIRR_APP_KEY);

          const telebirrRes = await axios.post(
            process.env.TELEBIRR_API_URL, // e.g., 'https://196.188.120.169:38443/apiaccess/payment/gateway/payment/v1/webpay'
            params,
            {
              headers: {
                'Content-Type': 'application/json',
              },
            }
          );

          if (!telebirrRes.data?.data?.toPayUrl) {
            throw new Error('Invalid Telebirr response');
          }

          return res.json({
            success: true,
            type: 'redirect',
            donation_id: donation.id,
            message: 'Redirect to Telebirr payment page',
            payment_url: telebirrRes.data.data.toPayUrl,
          });
        } catch (err) {
          console.error('Telebirr error:', err);
          return res.status(500).json({ success: false, message: 'Failed to initialize Telebirr payment' });
        }

      case 'paypal':
        try {
          // PayPal-specific env validation
          const paypalVars = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
          const missingPaypalVars = paypalVars.filter((varName) => !process.env[varName]);
          if (missingPaypalVars.length > 0) {
            return res.status(500).json({ success: false, message: 'PayPal configuration missing' });
          }

          const accessToken = await getPayPalAccessToken();

          const paypalRes = await axios.post(
            process.env.PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com/v2/checkout/orders' : 'https://api-m.paypal.com/v2/checkout/orders',
            {
              intent: 'CAPTURE',
              purchase_units: [
                {
                  amount: {
                    currency_code: donation.currency,
                    value: donation.amount.toFixed(2),
                  },
                  description: `Donation to Kuraa Galaan Charity (ID: ${donation.id})`,
                },
              ],
              application_context: {
                return_url: `${process.env.FRONTEND_URL}/donation/success?donation_id=${donation.id}`,
                cancel_url: `${process.env.FRONTEND_URL}/donation/cancel?donation_id=${donation.id}`,
              },
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const approvalUrl = paypalRes.data.links.find((link) => link.rel === 'approve')?.href;

          if (!approvalUrl) {
            throw new Error('Invalid PayPal response');
          }

          return res.json({
            success: true,
            type: 'redirect',
            donation_id: donation.id,
            message: 'Redirect to PayPal payment page',
            payment_url: approvalUrl,
          });
        } catch (err) {
          console.error('PayPal error:', err);
          return res.status(500).json({ success: false, message: 'Failed to initialize PayPal payment' });
        }

      case 'bank_transfer':
        try {
          // Bank-specific env validation
          const bankVars = ['BANK_ACCOUNT_NAME', 'BANK_ACCOUNT_NUMBER', 'BANK_NAME', 'BANK_BRANCH', 'BANK_SWIFT_CODE'];
          const missingBankVars = bankVars.filter((varName) => !process.env[varName]);
          if (missingBankVars.length > 0) {
            return res.status(500).json({ success: false, message: 'Bank configuration missing' });
          }

          const bankDetails = {
            accountName: process.env.BANK_ACCOUNT_NAME,
            accountNumber: process.env.BANK_ACCOUNT_NUMBER,
            bankName: process.env.BANK_NAME,
            branch: process.env.BANK_BRANCH,
            swiftCode: process.env.BANK_SWIFT_CODE,
          };

          let qrCodeUrl = null;
          try {
            const qrData = `Bank: ${bankDetails.bankName}\nAccount: ${bankDetails.accountNumber}\nName: ${bankDetails.accountName}\nSWIFT: ${bankDetails.swiftCode}\nAmount: ${donation.amount} ${donation.currency}\nRef: ${donation.id}`;
            qrCodeUrl = await QRCode.toDataURL(qrData);
          } catch (qrErr) {
            console.warn('QR code generation failed:', qrErr);
          }

          return res.json({
            success: true,
            type: 'manual',
            donation_id: donation.id,
            message: 'Please complete the bank transfer using the details below.',
            bankDetails,
            instructions: `Transfer ${donation.amount} ${donation.currency} to the provided account. Include the donation ID (${donation.id}) in the reference. Email proof to ${process.env.CONTACT_EMAIL}.`,
            verificationUrl: `${process.env.FRONTEND_URL}/donation/upload-proof?donation_id=${donation.id}`,
            ...(qrCodeUrl && { qrCode: qrCodeUrl }),
          });
        } catch (err) {
          console.error('Bank transfer error:', err);
          return res.status(500).json({ success: false, message: 'Failed to process bank transfer request' });
        }

      default:
        return res.status(400).json({ success: false, message: 'Unsupported payment method' });
    }
  } catch (error) {
    console.error('Donation creation error:', error);
    return res.status(500).json({ success: false, message: 'Server error: Unable to process donation' });
  }
});

// @route   POST /api/donations/verify
router.post('/verify', async (req, res) => {
  try {
    const { donation_id, tx_ref, status, method } = req.body; // Extend with method if needed

    // Fetch donation from database (uncomment when set up)
    // const donation = await Donation.findById(donation_id);
    // if (!donation) return res.status(404).json({ success: false, message: 'Donation not found' });

    switch (method || 'unknown') {
      case 'chapa':
        if (!tx_ref) return res.status(400).json({ success: false, message: 'Missing tx_ref' });
        const chapaVerify = await axios.get(
          `https://api.chapa.co/v1/transaction/verify/${tx_ref}`,
          {
            headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` },
          }
        );
        if (chapaVerify.data.status !== 'success') {
          return res.status(400).json({ success: false, message: 'Chapa verification failed' });
        }
        // Update status to 'completed'
        return res.json({ success: true, message: 'Chapa payment verified', data: { status: 'completed' } });

      case 'stripe':
        // Stripe typically uses webhooks for verification. Placeholder for session check.
        const session = await stripe.checkout.sessions.retrieve(tx_ref); // tx_ref as session_id
        if (session.payment_status !== 'paid') {
          return res.status(400).json({ success: false, message: 'Stripe verification failed' });
        }
        return res.json({ success: true, message: 'Stripe payment verified', data: { status: 'completed' } });

      case 'telebirr':
        // Telebirr sends notification to notifyUrl. For verification, decrypt payload if needed.
        // Placeholder: Assume req.body.payload is encrypted data
        const { payload } = req.body;
        if (!payload) return res.status(400).json({ success: false, message: 'Missing payload' });
        // Decryption logic (using public key, assuming RSA or similar from package)
        // For simplicity, assume success if status is 'success'
        if (status !== 'success') {
          return res.status(400).json({ success: false, message: 'Telebirr verification failed' });
        }
        return res.json({ success: true, message: 'Telebirr payment verified', data: { status: 'completed' } });

      case 'paypal':
        // PayPal uses webhooks or order capture. Placeholder for order check.
        const accessToken = await getPayPalAccessToken();
        const orderRes = await axios.get(
          `${process.env.PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'}/v2/checkout/orders/${tx_ref}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (orderRes.data.status !== 'COMPLETED') {
          return res.status(400).json({ success: false, message: 'PayPal verification failed' });
        }
        return res.json({ success: true, message: 'PayPal payment verified', data: { status: 'completed' } });

      case 'bank_transfer':
        // Manual verification, e.g., after proof upload
        return res.json({ success: true, message: 'Bank transfer pending manual review', data: { status: 'pending' } });

      default:
        return res.status(400).json({ success: false, message: 'Unsupported verification method' });
    }
  } catch (error) {
    console.error('Verification error:', error);
    return res.status(500).json({ success: false, message: 'Server error during verification' });
  }
});

// Other endpoints (history and stats) remain as placeholders
router.get('/history', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Donation history endpoint working',
      data: [],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error while fetching donation history' });
  }
});

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
    res.status(500).json({ success: false, message: 'Server error while fetching donation stats' });
  }
});

module.exports = router;
