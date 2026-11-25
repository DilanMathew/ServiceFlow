# Implementation status

This page is an honest snapshot of what is built, what runs in test or mock mode, and what still needs work before the product is used commercially.

## Built and verified

**Platform and security**
- Multi-tenant core with three-layer isolation (app scoping, FORCE RLS, composite FKs)
- Auth: JWT with refresh-token rotation and reuse detection, MFA, lockout, invitations, email verification, password reset
- RBAC with 9 system roles and custom roles

**Field service operations**
- CRM with duplicate detection
- Assets with QR codes
- Service requests and work orders with a state machine and history
- Technicians, skills, zones and leave
- Dispatch board with DB-enforced conflict prevention and assignment suggestions
- Technician mobile app with photos, parts, checklist and signature
- Calendar
- Customer portal

**Money**
- Quotations with revisions and online approval
- Invoices with GST/VAT, credit notes and immutability triggers
- Payments, refunds and idempotent signed webhooks
- Inventory with van stock, transfers and low-stock alerts
- AMC contracts with scheduled visit generation

**Communication, insight and admin**
- Notifications: a queued, retrying, dead-lettered outbox with templates
- Reports with CSV/PDF export
- AI features with a rules fallback, usage logging and quotas
- Documents with type sniffing and signed URLs
- Subscriptions with plans, entitlements, limits and read-only lapse
- Super Admin console
- Audit log (append-only)
- Privacy requests: export, rectification and erasure

**Demo and tests**
- Demo tenant "CoolCare Services" with realistic data
- 62 backend tests, including cross-tenant isolation and RBAC. All pass.
- A Playwright critical-journey E2E test that covers dispatcher → technician → accountant → customer. It passes locally.

## Test or mock modes (need credentials to go live)

| Area | Current mode | To go live |
|---|---|---|
| Platform email | `console` writes to the outbox and logs, and sends nothing | SMTP credentials |
| WhatsApp / SMS | No provider until a tenant configures one, so notifications are recorded and not sent | Meta Cloud API and approved templates, or Twilio |
| Customer payments | `test` gateway with a simulated checkout page | Razorpay or Stripe keys and webhook secret, set per tenant |
| SaaS billing | `manual`: the Super Admin activates subscriptions | Stripe or Razorpay keys |
| AI | `rules` (deterministic heuristics) | `ANTHROPIC_API_KEY` |
| Maps | OpenStreetMap links and geocoding | Optional Google Maps key |

Default plan prices (Starter, Growth, Business, Enterprise, in USD) are **placeholders**. They are seeded once, and the Super Admin should edit them before launch.

## Added in the second build round

| Item | What exists now | Verified by |
|---|---|---|
| Dependency security | multer 2, nodemailer 10, zod 4, React Router 7, Vite 8, Vitest 5, patched AWS SDK/Express. `npm audit`: 0 vulnerabilities | build, all tests, E2E |
| Error monitoring | Sentry (server + browser), off unless `SENTRY_DSN` is set; no personal data sent | unit test, smoke test with a dummy DSN |
| Storage health | Real S3 write/read/delete probe at boot and in `/api/health/ready` | test |
| Push notifications | Web push (VAPID) for staff devices: job assigned/rescheduled, approvals, low stock, e-invoice problems | API tests, browser test of the service worker showing a push |
| Offline technician mode | Installable PWA; jobs cached per user; accept/status/notes/parts/photos/signature/report queue offline and sync in order with idempotency keys; real start/finish times kept | `e2e/offline-technician.cjs`, API tests |
| E-invoicing | India GST IRN (sandbox + GSP adapter, cancel, QR on PDF) and EU UBL (Peppol BIS 3.0, XRechnung 3.0, invoices + credit notes, Access Point adapter) | 13 API tests, XML well-formedness (`xmllint`) |
| Translations | Hindi, German, French, Spanish for the technician app, customer portal, public invoice/quotation pages, sign-in, navigation and shared components (621 strings, checked by `npm run i18n:check -w web`); customer messages and PDFs in the business language (PDFs: de/fr/es) | catalog checker, tests, screenshots |
| Session fix | A refresh token replayed within 60 s of rotation (page reloaded mid-refresh) no longer logs the user out | test |

## Known gaps and recommended next work

1. **Redis.** `REDIS_URL` is accepted but unused. With several web replicas, move the rate-limit store to Redis.
2. **Translations of office screens.** Settings, reports, inventory, dispatch, invoices and the Super Admin console are still English. The system is in place: wrap strings in `t()` and run `npm run i18n:check -w web` to see what needs translating. Legal pages stay English until a lawyer approves translations. Hindi PDFs use English labels (the built-in PDF fonts cannot render Devanagari; embed a Devanagari font to change this).
3. **E-invoicing — official validation and live providers.** The UBL output follows EN 16931 / Peppol / XRechnung rules but was not run through the official validators here (see [EINVOICING.md](EINVOICING.md) for the one-command check). The IRP sandbox is a simulation; the GSP and Peppol Access Point adapters are generic and must be verified against your chosen provider's sandbox. India e-way bills are not implemented.
4. **Push on iPhone** works only after the app is added to the Home Screen (iOS 16.4+). Delivery to real push services could not be exercised from the build sandbox.
5. **Payment gateways and messaging were verified only in test mode.** Do a live test transaction before launch.
6. **Load and penetration testing** has not been performed.
7. **Legal.** Terms, privacy policy, DPA and sub-processor list need legal review. **GDPR / DPDP compliance is not claimed.**
8. **Backups.** Turn on Railway Postgres backups and run a restore drill. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
