const { PrismaClient } = require('@prisma/client');

let prisma;

if (!global.__prisma) {
  global.__prisma = new PrismaClient({
    log: ['error','warn']
  });
}
prisma = global.__prisma;

module.exports = { prisma };
