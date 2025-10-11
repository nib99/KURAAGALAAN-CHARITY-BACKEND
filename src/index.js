require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const donationRoutes = require('./routes/donation');
const userRoutes = require('./routes/users');
const { prisma } = require('./lib/prisma');

const app = express();

// =========================
// TRUST PROXY (for headers in cloud hosting)
app.set('trust proxy', 1);

// =========================
// HEALTH CHECK ROUTE
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// =========================
// MIDDLEWARE (must come BEFORE routes)
// =========================

// 1️⃣ Parse JSON bodies
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 2️⃣ Security headers
app.use(helmet());

// 3️⃣ CORS (allow frontend URL)
const allowedOrigin = process.env.ALLOWED_ORIGIN || process.env.FRONTEND_URL || 'https://kuraa-galaan-website.vercel.app';
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow server-to-server or Postman
    if (origin === allowedOrigin) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  optionsSuccessStatus: 200
}));

// 4️⃣ Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_MAX || 200),
  standardHeaders: true,
  legacyHeaders: false
}));

// =========================
// ROUTES
// =========================

// Donation API
app.use('/api/donation', donationRoutes);

// User API
app.use('/api/users', userRoutes);

// Root test route
app.get('/', (_req, res) => res.send('✅ Kuraa Galaan Backend is running'));

// =========================
// GLOBAL ERROR HANDLER
// =========================
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err?.message || err);
  res.status(500).json({ success: false, error: 'Internal Server Error' });
});

// =========================
// START SERVER + DATABASE
// =========================
const PORT = process.env.PORT || 3000;

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

start();

// =========================
// GRACEFUL SHUTDOWN
// =========================
async function shutdown(signal) {
  console.log(`${signal} - shutting down gracefully...`);
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
