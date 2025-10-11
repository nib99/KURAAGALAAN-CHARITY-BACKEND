const express = require("express");
const router = express.Router();

// @route   POST /api/donation/create
// @desc    Create a new donation
// @access  Public
router.post("/create", async (req, res) => {
  try {
    const { name, email, phone, amount, currency, method, message, anonymous } = req.body;

    // Basic validation
    if (!name || !amount || !currency || !method) {
      return res.status(400).json({
        success: false,
        message: "Name, amount, currency, and payment method are required",
      });
    }

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
      id: "donation_" + Date.now(),
      name: anonymous ? "Anonymous" : name,
      email: email || null,
      phone: phone || null,
      amount: parseFloat(amount),
      currency,
      amount_etb: convertToETB(amount, currency),
      method,
      message: message || null,
      anonymous: anonymous || false,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    // Payment processing by method
    switch (method) {
      case "bank_transfer":
        return res.json({
          success: true,
          type: "manual",
          message: "Bank transfer donation recorded successfully.",
          donation_id: donation.id,
          bankDetails: {
            accountName: "Kuraa Galaan Charity Organization",
            accountNumber: "1000123456789",
            bankName: "Commercial Bank of Ethiopia",
            branch: "Bole Branch",
            swiftCode: "CBETETAA",
          },
        });

      case "chapa":
        return res.json({
          success: true,
          type: "redirect",
          message: "Redirect to Chapa payment",
          donation_id: donation.id,
          payment_url: "https://chapa.co/pay/example-link",
        });

      case "telebirr":
        return res.json({
          success: true,
          type: "redirect",
          message: "Telebirr payment initialized",
          donation_id: donation.id,
          payment_url: "https://telebirr.et/pay/example-transaction",
        });

      case "paypal":
        return res.json({
          success: true,
          type: "redirect",
          message: "Redirect to PayPal donation page",
          donation_id: donation.id,
          payment_url: "https://paypal.com/donate/example",
        });

      case "stripe":
        return res.json({
          success: true,
          type: "redirect",
          message: "Redirect to Stripe Checkout",
          donation_id: donation.id,
          payment_url: "https://checkout.stripe.com/pay/example",
        });

      default:
        return res.status(400).json({
          success: false,
          message: "Unsupported payment method",
        });
    }
  } catch (error) {
    console.error("Create donation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing donation",
    });
  }
});

// @route   GET /api/donation/history
router.get("/history", async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Donation history endpoint working",
      data: [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching donation history",
    });
  }
});

// @route   GET /api/donation/stats
router.get("/stats", async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Donation stats endpoint working",
      data: {
        totalDonations: 0,
        totalAmount: 0,
        donorCount: 0,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error while fetching donation stats",
    });
  }
});

// @route   POST /api/donation/verify
router.post("/verify", async (req, res) => {
  try {
    const { donation_id, payment_id } = req.body;

    res.json({
      success: true,
      message: "Payment verification endpoint working",
      data: {
        donation_id,
        payment_id,
        status: "verified",
      },
    });
  } catch (error) {
    console.error("Verify payment error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while verifying payment",
    });
  }
});

module.exports = router;
