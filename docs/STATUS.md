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

## Known gaps and recommended next work

1. **Error monitoring.** `SENTRY_DSN` is accepted in config but no SDK is wired in yet. Add `@sentry/node` and `@sentry/react`, or another APM.
2. **Redis.** `REDIS_URL` is accepted but unused. The queue and rate limiting run on Postgres and in memory. With several web replicas, move the rate-limit store to Redis.
3. **Offline technician mode.** The technician app needs connectivity. A service worker with an action queue would help in poor coverage areas.
4. **Localisation.** The UI is English only. Currency, tax and date formats are already per tenant. String translation (for example Hindi, German, French) is not done.
5. **Native push notifications** for technicians are not implemented. Today they get email, WhatsApp and SMS.
6. **E-invoicing.** India IRN/e-way bill and EU e-invoicing formats (Peppol, XRechnung) are not integrated.
7. **Payment gateways and messaging were verified only in test mode.** The live Razorpay, Stripe and Meta webhooks have not been exercised against real accounts. Do a live test transaction before launch.
8. **Load and penetration testing** has not been performed.
9. **Legal.** Terms, privacy policy, DPA and sub-processor list need legal review. **GDPR / DPDP compliance is not claimed.** The product provides tooling (export, erasure, consent, audit, encryption of secrets), but compliance depends on operations and contracts.
10. **Backups.** Turn on Railway Postgres backups and run a restore drill. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
