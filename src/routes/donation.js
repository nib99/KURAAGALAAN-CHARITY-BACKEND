const express = require('express');
const router = express.Router();

// Simple donation route - just returns success for now
// @route   POST /api/donation/create
// @desc    Create new donation
// @access  Public
router.post('/create', async (req, res) => {
  try {
    const { name, email, phone, amount, currency, method, message, anonymous } = req.body;
    
    // Basic validation
    if (!name || !amount || !currency || !method) {
      return res.status(400).json({
        success: false,
        message: 'Name, amount, currency, and payment method are required'
      });
    }

    // Currency conversion rates (simplified)
    const exchangeRates = {
      'USD': 55.50,
      'EUR': 60.25,
      'SAR': 14.80,
      'ETB': 1.00
    };

    const convertToETB = (amount, currency) => {
      return parseFloat((amount * exchangeRates[currency]).toFixed(2));
    };

    const donation = {
      id: 'donation_' + Date.now(),
      name: anonymous ? 'Anonymous' : name,
      email: email || null,
      phone: phone || null,
      amount: parseFloat(amount),
      currency: currency,
      amount_etb: convertToETB(amount, currency),
      method: method,
      message: message || null,
      anonymous: anonymous || false,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    
    res.status(201).json({
      success: true,
      message: 'donation initiated successfully',
      donation_id: donation.id,
      amount: `${donation.amount} ${donation.currency}`,
      method: donation.method,
      status: donation.status
    });
  } catch (error) {
    console.error('Create donation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing donation'
    });
  }
});

// @route   GET /api/donation/history
// @desc    Get donation history
// @access  Public
router.get('/history', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'donation history endpoint working',
      data: []
    });
  } catch (error) {
    console.error('Get donation history error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching donation history'
    });
  }
});

// @route   GET /api/donation/stats
// @desc    Get donation statistics
// @access  Public
router.get('/stats', async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'donation stats endpoint working',
      data: {
        totalDonations: 0,
        totalAmount: 0,
        donorCount: 0
      }
    });
  } catch (error) {
    console.error('Get donation stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching donation stats'
    });
  }
});

// @route   POST /api/donation/verify
// @desc    Verify payment
// @access  Public
router.post('/verify', async (req, res) => {
  try {
    const { donation_id, payment_id } = req.body;
    
    res.json({
      success: true,
      message: 'Payment verification endpoint working',
      data: {
        donation_id: donation_id,
        payment_id: payment_id,
        status: 'verified'
      }
    });
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while verifying payment'
    });
  }
});

module.exports = router;
