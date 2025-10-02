const { PrismaClient } = require('@prisma/client');

const globalForPrisma = global;

const prisma = globalForPrisma.__prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error', 'warn'],
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.__prisma = prisma;

module.exports = { prisma };
