require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const donateRoutes = require('./routes/donate');
const userRoutes = require('./routes/users');
const { prisma } = require('./lib/prisma');

const app = express();

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(helmet());

const allowedOrigin = process.env.ALLOWED_ORIGIN || process.env.FRONTEND_URL || 'https://kuraa-galaan-website.vercel.app';
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin === allowedOrigin) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  optionsSuccessStatus: 200
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 200),
  standardHeaders: true,
  legacyHeaders: false
}));

app.use('/api/donate', donateRoutes);
app.use('/api/users', userRoutes);

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err?.message || err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;

// Wrap server start in async function
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');

    app.listen(PORT, () => {
      console.log(`🚀 Backend running on port ${PORT}`);
    });

  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
}

// Start server
start();

// Graceful shutdown
async function shutdown(signal) {
  console.log(`${signal} - shutting down`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
