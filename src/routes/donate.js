const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');
const Stripe = require('stripe');
const fetch = require('node-fetch');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Helper: create donation record
async function createDonationRecord({ name, amount, method, reference }) {
  return prisma.donation.create({
    data: {
      name,
      amount: Number(amount),
      method,
      reference
    }
  });
}

/*
  POST /api/donate
  body: { name, amount, method, paymentMethodData }
  method: one of "stripe", "chapa", "telebirr", or "manual"
*/
router.post('/', async (req, res) => {
  try {
    const { name, amount, method, paymentMethodData } = req.body;
    if (!name || !amount || !method) {
      return res.status(400).json({ error: 'Missing required fields: name, amount, method' });
    }

    // Stripe flow (recommended for card payments / global)
    if (method.toLowerCase() === 'stripe') {
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      // Create a PaymentIntent server-side
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(Number(amount) * 100), // in cents
        currency: process.env.STRIPE_CURRENCY || 'usd',
        metadata: { donor: name },
      });

      // Save a tentative donation record with reference = intent id
      const donation = await createDonationRecord({ name, amount, method: 'stripe', reference: intent.id });

      return res.json({ success: true, provider: 'stripe', clientSecret: intent.client_secret, donation });
    }

    // Chapa flow (Ethiopia) - example (https://chapa.co)
    if (method.toLowerCase() === 'chapa') {
      const chapaKey = process.env.CHAPA_SECRET_KEY;
      if (!chapaKey) return res.status(500).json({ error: 'Chapa not configured' });

      // Example request payload to initialize payment (adjust per Chapa docs)
      const chapaPayload = {
        amount: Number(amount),
        currency: process.env.CHAPA_CURRENCY || 'ETB',
        email: paymentMethodData?.email || 'donor@example.com',
        first_name: name,
        callback_url: paymentMethodData?.callback_url || `${process.env.FRONTEND_URL}/donation-success`,
        reference: `chapa_${Date.now()}`
      };

      const resp = await fetch('https://api.chapa.co/v1/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${chapaKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chapaPayload)
      });

      const chapaRes = await resp.json();

      // Save record with chapa tx reference if available
      const donation = await createDonationRecord({ name, amount, method: 'chapa', reference: chapaRes?.data?.checkout_url || chapaPayload.reference });

      return res.json({ success: true, provider: 'chapa', chapa: chapaRes, donation });
    }

    // Telebirr flow (placeholder) - Telebirr integration often uses specific APIs
    if (method.toLowerCase() === 'telebirr') {
      // Telebirr integration is country-specific; typically you receive a payment token from client/Telebirr then verify server-side.
      // Placeholder: record donation and return instructions
      const ref = `telebirr_${Date.now()}`;
      const donation = await createDonationRecord({ name, amount, method: 'telebirr', reference: ref });
      return res.json({ success: true, provider: 'telebirr', message: 'Use Telebirr app to transfer to account XYZ', donation });
    }

    // Manual / bank transfer
    if (method.toLowerCase() === 'manual' || method.toLowerCase() === 'bank') {
      const ref = `manual_${Date.now()}`;
      const donation = await createDonationRecord({ name, amount, method: 'manual', reference: ref });
      return res.json({ success: true, provider: 'manual', donation });
    }

    return res.status(400).json({ error: 'Unsupported payment method' });
  } catch (err) {
    console.error('donate error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const donations = await prisma.donation.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ success: true, donations });
  } catch (err) {
    console.error('donations fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
