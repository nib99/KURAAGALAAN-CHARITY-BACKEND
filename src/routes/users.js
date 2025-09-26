const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');

router.get('/', async (_req, res) => {
  try {
    const users = await prisma.user.findMany();
    res.json({ success: true, users });
  } catch (err) {
    console.error('users fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
