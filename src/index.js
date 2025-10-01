const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { connectDB } = require('./config/database');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const logger = require('./utils/logger');
require('dotenv').config();

// Import routes
const donateRoutes = require('./routes/donate');
const userRoutes = require('./routes/users');
const contactRoutes = require('./routes/contact');
const adminRoutes = require('./routes/admin');
const statsRoutes = require('./routes/stats');
const webhookRoutes = require('./routes/webhooks');
const downloadRoutes = require('./routes/download');

const app = express();
const PORT = process.env.PORT || 5000;

// Connect to database
connectDB();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
    origin: [
        'https://kuraa-galaan-website.vercel.app',
        'https://kuraa-galaan-website-git-main-your-username.vercel.app',
        'https://kuraa-galaan-website-your-username.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger.request(req, res, duration);
    });
    next();
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    const { testConnection } = require('./config/database');
    const dbStatus = await testConnection();
    
    res.json({
        success: true,
        message: 'Kuraa Galaan Charity Backend - Healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        database: dbStatus ? 'connected' : 'disconnected',
        environment: process.env.NODE_ENV || 'development'
    });
});

// API Routes
app.use('/api/donate', donateRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/download', downloadRoutes);

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'Kuraa Galaan Charity Organization API',
        version: '1.0.0',
        status: 'active',
        frontend: 'https://kuraa-galaan-website.vercel.app',
        documentation: '/api/docs',
        health: '/api/health'
    });
});

// 404 handler
app.use(notFound);

// Global error handler
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully');
    const { closeConnection } = require('./config/database');
    await closeConnection();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully');
    const { closeConnection } = require('./config/database');
    await closeConnection();
    process.exit(0);
});

app.listen(PORT, () => {
    logger.info(`🚀 Kuraa Galaan Charity Backend Server Started on Port ${PORT}`);
    logger.info(`🔗 Frontend: https://kuraa-galaan-website.vercel.app`);
    logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
