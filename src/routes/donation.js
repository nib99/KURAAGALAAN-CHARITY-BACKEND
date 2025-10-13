const express = require('express');

const router = express.Router();

const { body, validationResult } = require('express-validator');

const axios = require('axios');

const { v4: uuidv4 } = require('uuid');

require('dotenv').config();



// Validation rules

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



// Helper function to get PayPal access token

const getPayPalAccessToken = async () => {

  const response = await axios.post(

    'https://api-m.sandbox.paypal.com/v1/oauth2/token',

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



    // Payment processing

    switch (method) {

      case 'bank_transfer':

        return res.json({

          success: true,

          type: 'redirect',

          message: 'Redirecting to bank transfer instructions',

          donation_id: donation.id,

          payment_url: `${process.env.WEBSITE_URL}/bank-transfer-instructions?donation_id=${donation.id}`,

          bankDetails: {

            accountName: process.env.BANK_ACCOUNT_NAME || 'Kuraa Galaan Charity Organization',

            accountNumber: process.env.BANK_ACCOUNT_NUMBER || '1000449482167',

            bankName: process.env.BANK_NAME || 'Commercial Bank of Ethiopia',

            branch: process.env.BANK_BRANCH || 'Bole Branch',

            swiftCode: process.env.BANK_SWIFT_CODE || 'CBETETAA',

            instructions: `Please transfer ${donation.amount} ${donation.currency} to the provided account and send the transaction receipt to ${process.env.CONTACT_EMAIL} with donation ID ${donation.id}.`,

          },

        });



      case 'paypal':

        // Get PayPal access token

        const accessToken = await getPayPalAccessToken();



        // Create PayPal payment

        const paypalResponse = await axios.post(

          'https://api-m.sandbox.paypal.com/v2/checkout/orders',

          {

            intent: 'CAPTURE',

            purchase_units: [

              {

                amount: {

                  currency_code: currency,

                  value: amount.toFixed(2),

                },

                description: `Donation to Kuraa Galaan Charity (ID: ${donation.id})`,

              },

            ],

            application_context: {

              return_url: `${process.env.WEBSITE_URL}/donation/success?donation_id=${donation.id}`,

              cancel_url: `${process.env.WEBSITE_URL}/donation/cancel?donation_id=${donation.id}`,

            },

          },

          {

            headers: {

              Authorization: `Bearer ${accessToken}`,

              'Content-Type': 'application/json',

            },

          }

        );



        // Find the approval URL (redirect URL) in PayPal response

        const approvalUrl = paypalResponse.data.links.find(

          (link) => link.rel === 'approve'

        ).href;



        return res.json({

          success: true,

          type: 'redirect',

          message: 'Redirect to PayPal payment page',

          donation_id: donation.id,

          payment_url: approvalUrl,

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

    console.error('Create donation error:', error.message, error.stack);

    return res.status(500).json({

      success: false,

      message: `Server error: ${error.message}`,

    });

  }

});



// Other endpoints (unchanged)

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

