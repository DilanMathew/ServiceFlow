# NEXUS ServiceFlow

**Manage Every Service. Every Customer. Every Job.** A product of **NEXUS by DIL**.

NEXUS ServiceFlow is a multi-tenant field service management SaaS. It is built for AC, electrical, plumbing, appliance, CCTV, solar, generator and general service businesses in India, Europe and other markets. It covers:

- CRM and customer assets with QR codes
- Service requests, work orders and dispatch
- Technician and customer portals
- Quotations, invoicing (GST/VAT), payments and inventory
- AMC contracts and notifications, including web push to technicians' phones
- An installable technician app that keeps working offline and syncs when back online
- E-invoicing: India GST IRN and EU Peppol BIS 3.0 / XRechnung
- English, Hindi, German, French and Spanish for technicians, customers and sign-in
- AI assistance and reports
- Subscription billing, with a Super Admin console for the platform operator

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, tenant isolation, security model, background jobs, integrations |
| [docs/API.md](docs/API.md) | REST conventions, auth flow, error codes, full endpoint list |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Railway deployment, environment variables, going live with integrations |
| [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) | Database and file backups, restore drills |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | How each role uses the product |
| [docs/EINVOICING.md](docs/EINVOICING.md) | India GST IRN and EU Peppol/XRechnung setup and validation |
| [docs/STATUS.md](docs/STATUS.md) | What is done, what runs in test mode, known gaps and next steps |
| [.env.example](.env.example) | Every configuration variable, documented |

## Stack

- **Frontend (`web/`):** React 18, TypeScript, Vite, Tailwind CSS, a shadcn-style component set, Lucide icons, React Router, TanStack Query, React Hook Form, Zod and Recharts.
- **Backend (`server/`):** Node.js 20/22, Express, TypeScript and a REST API. Auth uses JWT access tokens and rotating refresh cookies, with RBAC and TOTP MFA.
- **Database:** PostgreSQL 15+. It uses SQL migrations, row-level security (RLS) on every tenant table, and exclusion constraints against double-booking.
- **Jobs:** a durable Postgres-backed queue with retries and a dead-letter state, plus a scheduler. Redis is optional and not required.
- **Integrations:** each sits behind a provider interface with a safe default.
  - S3-compatible storage
  - SMTP email
  - Meta WhatsApp Cloud API (official API only)
  - Twilio SMS
  - Razorpay and Stripe
  - OpenStreetMap and Google Maps
  - Anthropic Claude for AI

## Local development

Prerequisites: Node 20 or 22 (see `.nvmrc`) and PostgreSQL 15+ running locally.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your environment file:

   ```bash
   cp .env.example server/.env
   ```

   Then edit `server/.env`. At minimum set `DATABASE_URL`, `JWT_SECRET` and `ENCRYPTION_KEY`. Generate the two secrets with:

   ```bash
   node -e "const c=require('crypto');console.log('JWT_SECRET='+c.randomBytes(48).toString('base64url'));console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'))"
   ```

3. Create the database and apply migrations:

   ```bash
   createdb serviceflow
   ```

   ```bash
   npm run migrate
   ```

4. Load the CoolCare Services demo tenant (optional):

   ```bash
   npm run seed
   ```

5. Start the API on :4000 and the web app on :5173 (Vite proxies `/api`):

   ```bash
   npm run dev
   ```

Open http://localhost:5173.

The server applies migrations on boot, so step 3 is optional. With `SEED_DEMO=true` it also seeds the demo tenant on first boot.

### Demo accounts (seeded)

Workspace slug is `coolcare`. Password for every demo account is `CoolCare@2026`, or the value of `DEMO_PASSWORD`.

| Role | Email |
|---|---|
| Owner | owner@coolcare.example |
| Admin | admin@coolcare.example, ops@coolcare.example |
| Dispatcher | dispatch@coolcare.example |
| Accountant | accounts@coolcare.example |
| Technician | tech@coolcare.example (also tech2 … tech10) |
| Customer (portal) | customer@coolcare.example |

The platform Super Admin is created from `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` on boot.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API (tsx watch) and web (Vite) together |
| `npm run build` | Production build: `web/dist` and `server/dist` |
| `npm start` | Run the built server. It serves `/api` and the SPA on `PORT` |
| `npm run migrate` | Apply pending SQL migrations (advisory-locked, idempotent) |
| `npm run seed` | Seed the demo tenant (skips it if it already exists) |
| `npm test` | Backend test suite (Vitest) against a throwaway `serviceflow_test` database |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run i18n:check -w web` | Checks every translated string exists in the hi/de/fr/es catalogs |
| `BASE_URL=http://localhost:4000 node e2e/offline-technician.cjs` | Offline technician journey: queue work without signal, sync on reconnect |
| `BASE_URL=http://localhost:4000 node e2e/critical-journeys.cjs` | Playwright critical-journey test: dispatcher, then technician on mobile, then accountant, then customer |

### Tests

`npm test` needs a reachable Postgres. It uses `TEST_DATABASE_URL`, falling back to `postgres://postgres:postgres@localhost:5432/serviceflow_test`, and drops and recreates that database's schema. Never point it at a real database. The suite covers:

- Authentication, lockout, refresh-token rotation and reuse detection
- **Cross-tenant isolation**, at both the API and RLS level
- The RBAC matrix
- CRM duplicates
- The work-order state machine and dispatch conflicts
- Quotation revisions
- Invoice immutability, payments, refunds and webhook idempotency
- AMC visit generation, notifications, documents and the customer portal

## Project structure

```
server/
  migrations/          001_core.sql (schema), 002_rls.sql (roles + RLS policies)
  src/
    app.ts             Express app: security headers, rate limits, routing, error mapping, SPA
    index.ts           Boot: migrate → reference data → platform admin → seed → worker → listen
    config.ts          Validated environment (zod)
    db/                pool (withTenant / withSystem), migrator
    auth/              permissions catalog, tokens, middleware, context
    jobs/              queue, handlers, scheduler
    integrations/      storage, email, messaging, payments, maps, ai
    modules/           one folder per business domain (routes + services)
    seed/              demo + sample data
  tests/               Vitest suites
web/
  src/
    components/        ui kit, layout, charts, forms
    pages/             public, auth, app (business), tech, portal, platform
    lib/               api client, auth context, formatting, hooks
e2e/                   Playwright journey script
docs/                  documentation
```

## Important notes

- **Compliance.** ServiceFlow includes data-protection tooling: data export, erasure requests, consent flags, retention, audit logs and encryption of stored integration secrets. **It is not certified or claimed to be GDPR (or DPDP) compliant.** Compliance depends on how each business operates. Get legal review before you market it as compliant.
- **No card data is stored.** Payments go through hosted gateway checkouts. Only gateway references are kept.
- **WhatsApp** uses only the official Meta WhatsApp Cloud API with approved templates. No unofficial automation is used.
- **Integrations default to safe modes:**
  - Console email
  - Logged-only messaging
  - The `test` payment provider
  - The rules-based AI engine
  - Manual subscription billing

  Live credentials are documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
