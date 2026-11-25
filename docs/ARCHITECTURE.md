# Architecture

## Overview

ServiceFlow runs as one Node.js process. That process serves:

- the REST API under `/api`
- the built React SPA (`web/dist`)
- the background job worker and scheduler, unless `RUN_WORKER=false`

PostgreSQL is the only required stateful dependency. Files go to S3-compatible object storage in production.

```
Browser (React SPA) ──HTTPS──▶ Express
                                ├─ /api/auth        login, MFA, refresh, invitations, password reset
                                ├─ /api/app/*       business app (staff of a tenant)
                                ├─ /api/portal/*    customer portal (customer users of a tenant)
                                ├─ /api/platform/*  Super Admin (platform operators)
                                ├─ /api/public/*    signed links: invoice/quotation view & pay, asset QR, files
                                └─ /api/webhooks/*  payment/billing/WhatsApp callbacks (signature-verified)
                               PostgreSQL ◀── worker (queue + scheduler)  ──▶ email / WhatsApp / SMS / gateways
```

## Multi-tenancy and isolation

Every business table carries `tenant_id`. Isolation is enforced in three independent layers.

1. **Application layer.** Tenant code runs inside `withTenant(tenantId, fn)`.
   - The tenant id comes only from the verified JWT, never from request parameters.
   - Every query a module writes is tenant-scoped.
2. **Database row-level security.** `withTenant` opens a transaction and runs `SET LOCAL ROLE app_tenant` and `set_config('app.tenant_id', …)`.
   - `app_tenant` is a non-superuser role.
   - Every tenant table has `FORCE ROW LEVEL SECURITY` with policies of the form `tenant_id = current_setting('app.tenant_id')::uuid`.
   - A missed `WHERE` clause therefore still cannot read or write another tenant's rows.
3. **Referential layer.** Foreign keys are composite, `(tenant_id, id)`. A row cannot reference another tenant's customer, asset or technician, even by a guessed UUID.

`withSystem` bypasses RLS. Only these use it:

- authentication (resolving a user before a tenant is known)
- the Super Admin platform
- inbound webhooks, after their signature has been verified
- the scheduler

`server/tests/isolation.test.ts` covers cross-tenant reads, writes, references and direct RLS checks.

## Authentication and authorization

**Tokens**
- **Access token:** a JWT valid for 15 minutes, held in memory by the SPA and never in localStorage.
- **Refresh token:** an opaque token in an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/api/auth`.
  - It is rotated on every use.
  - Reusing an old refresh token revokes the whole session family.
  - Refresh requests also require the `X-Requested-With: ServiceFlow` header.

**Passwords and sign-in**
- Passwords are hashed with scrypt.
- An account locks after 8 failed attempts.
- Optional TOTP MFA is available. Its seeds are encrypted with `ENCRYPTION_KEY`.
- Email verification, password reset and invitation tokens are stored only as SHA-256 hashes, with expiry.

**Authorization**
- RBAC uses a permission catalog (`server/src/auth/permissions.ts`) and these system roles:
  - Owner, Admin, Branch Manager, Operations Manager, Dispatcher, Technician and Accountant (tenant staff)
  - Customer (portal)
  - Super Admin (platform)
- Tenants on plans with `advanced_permissions` can create custom roles.
- Technicians only see work orders assigned to them. Branch-scoped users only see their branch.

**Super Admin support access**
- It requires a time-limited grant issued by the tenant.
- It is read-only, and it is audit-logged.

## Plans and entitlements

Plans live in `subscription_plans`. They are seeded once and are editable by the Super Admin, so no price is read from code.

**Features.** Plans gate features with `requireFeature`, for example `inventory`, `ai` and `multi_branch`.

**Limits.** Plans also enforce limits on users, technicians, branches, monthly work orders, storage and AI requests.

**Subscription states.**
- `trialing` and `active` give full access.
- `past_due` is within the grace period.
- `expired` and `suspended` make tenants **read-only**: writes return `402`.

## Data integrity rules (enforced in the database)

- **No double booking.** A GiST exclusion constraint on `job_assignments` (`technician_id`, `time_window`) rejects overlapping assignments with `409 SCHEDULE_CONFLICT`, even under concurrency.
- **Issued invoices are immutable.** A trigger blocks edits to issued invoices and their lines. Corrections go through credit notes. Quotation lines are locked once a quotation leaves draft, and revisions create new versions.
- **Balances.** `invoices.balance_due` is a generated column: `total − amount_paid − amount_credited`.
- **Money** is stored as integer minor units (paise/cents), with per-line tax components such as CGST/SGST/IGST or VAT.
- **Gapless numbering.** Each tenant has its own document numbering (`tenant_counters`, row-locked).
- **Audit log.** `audit_logs` is append-only: a trigger rejects UPDATE and DELETE.
- **Work-order state machine.** Allowed transitions are validated server-side, and every change is recorded in history.

## Background jobs

`background_jobs` is a durable Postgres queue.
- Workers claim jobs with `FOR UPDATE SKIP LOCKED`.
- Failed jobs retry with exponential backoff.
- A job that exhausts its retries moves to `dead`. Dead jobs show in the Super Admin console and can be retried there.
- Notifications are enqueued inside the business transaction, so a failing email or WhatsApp provider never blocks or rolls back a job update.

Scheduled tasks run under Postgres advisory locks, so this is safe with multiple replicas.

| Task | What it does |
|---|---|
| AMC visits | Generates upcoming preventive-maintenance work orders |
| Overdue invoices | Marks invoices overdue and sends reminders |
| Quotation expiry | Expires quotations past their validity date |
| Job reminders | Sends job reminders |
| Low stock | Sends low-stock alerts |
| Subscriptions | Handles trial and expiry transitions |
| Cleanup | Removes expired tokens and old sessions |

## Integrations

Every integration sits behind a provider interface (`server/src/integrations`) with a safe default.

| Kind | Providers | Default | Configured by |
|---|---|---|---|
| File storage | local disk, S3-compatible | local | env |
| Platform email | console/outbox, SMTP | console | env |
| WhatsApp | Meta WhatsApp Cloud API (official only) | disabled | tenant, the Integrations page |
| SMS | Twilio | disabled | tenant |
| Customer payments | test gateway, Razorpay, Stripe | test | tenant |
| SaaS billing | manual, test, Stripe, Razorpay | manual | env |
| Maps | OpenStreetMap, Google | OSM | env |
| AI | rules engine, Anthropic Claude | rules | env |

**Tenant credentials** are encrypted with AES-256-GCM (`ENCRYPTION_KEY`) and are never returned to the browser.

**Webhooks**
- Webhooks are verified with HMAC (Razorpay/Stripe signatures, or Meta's `X-Hub-Signature-256`).
- They are deduplicated through the `webhook_events` ledger, so redelivery is idempotent.

**Uploads**
- Uploaded files are checked by magic-byte type sniffing.
- They are served only via short-lived signed tokens.

**AI**
- AI calls use structured JSON output.
- Each call is logged in `ai_usage_logs` and counted against plan quotas.
- If the provider is unavailable, AI features fall back to the deterministic rules engine.
- AI never changes data by itself. Suggestions are reviewed and applied by a user.
