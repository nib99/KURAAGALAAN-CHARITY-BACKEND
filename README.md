# Kuraa Galaan Backend (JavaScript) - Ready for Render

This is a ready-to-deploy Node.js + Express backend with Prisma (Postgres). It includes example donation routes with recommended payment integrations (Stripe, Chapa, Telebirr placeholders).

## Quick start (local)
1. Copy `.env.example` to `.env` and set your values.
2. Install:
   ```
   npm ci
   ```
3. Generate Prisma client:
   ```
   npx prisma generate
   ```
4. Run migrations locally (optional):
   ```
   npx prisma migrate dev --name init
   ```
5. Start dev server:
   ```
   npm run dev
   ```

## Deploy to Render
1. Push this repo to GitHub.
2. Create a new Web Service on Render, connect repo.
3. Use build command: `npm ci && npx prisma generate`
4. Use start command: `npm start`
5. Add environment variables in Render: `DATABASE_URL`, `ALLOWED_ORIGIN`, `FRONTEND_URL`, `STRIPE_SECRET_KEY`, `CHAPA_SECRET_KEY`, etc.

## Payment integrations
- Stripe: used for card payments (creates PaymentIntent).
- Chapa: example initialization call to their API (adjust according to Chapa docs).
- Telebirr: placeholder flow — Telebirr integrations require provider credentials and their API; implement verification according to Telebirr documentation.

Make sure to secure your keys and never commit `.env`.
