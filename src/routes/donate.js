const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Helper: dynamically import node-fetch
async function makeFetchRequest(url, options) {
  const { default: fetch } = await import('node-fetch');
  return fetch(url, options);
}

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

    // Stripe flow
    if (method.toLowerCase() === 'stripe') {
      if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

      const intent = await stripe.paymentIntents.create({
        amount: Math.round(Number(amount) * 100),
        currency: process.env.STRIPE_CURRENCY || 'usd',
        metadata: { donor: name },
      });

      const donation = await createDonationRecord({ name, amount, method: 'stripe', reference: intent.id });

      return res.json({ success: true, provider: 'stripe', clientSecret: intent.client_secret, donation });
    }

    // Chapa flow
    if (method.toLowerCase() === 'chapa') {
      const chapaKey = process.env.CHAPA_SECRET_KEY;
      if (!chapaKey) return res.status(500).json({ error: 'Chapa not configured' });

      const chapaPayload = {
        amount: Number(amount),
        currency: process.env.CHAPA_CURRENCY || 'ETB',
        email: paymentMethodData?.email || 'donor@example.com',
        first_name: name,
        callback_url: paymentMethodData?.callback_url || `${process.env.FRONTEND_URL}/donation-success`,
        reference: `chapa_${Date.now()}`
      };

      const resp = await makeFetchRequest('https://api.chapa.co/v1/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${chapaKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chapaPayload)
      });

      const chapaRes = await resp.json();
      const donation = await createDonationRecord({
        name,
        amount,
        method: 'chapa',
        reference: chapaRes?.data?.checkout_url || chapaPayload.reference
      });

      return res.json({ success: true, provider: 'chapa', chapa: chapaRes, donation });
    }

    // Telebirr flow
    if (method.toLowerCase() === 'telebirr') {
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