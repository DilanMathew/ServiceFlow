# API reference

The base URL is `<APP_URL>/api`. All requests and responses are JSON unless noted otherwise. CSV and PDF exports return files.

## Authentication

1. Log in with `POST /api/auth/login`, sending `{ "email", "password", "workspace"? }`. `workspace` is the tenant slug.
   - The response is `{ data: { accessToken } }`. If MFA is on, it is `{ data: { mfaRequired, mfaToken } }` instead.
   - Complete MFA with `POST /api/auth/mfa/verify`.
   - Call `GET /api/auth/me` for the user, role and permissions.
   - Login also sets the refresh cookie `sf_rt` (`httpOnly`, path `/api/auth`).
2. Send `Authorization: Bearer <accessToken>` on every request. Access tokens expire after 15 minutes.
3. Refresh with `POST /api/auth/refresh`. This call needs the cookie and the header `X-Requested-With: ServiceFlow`. Each refresh rotates the token, and reusing an old refresh token revokes the session.

Use the API area that matches the user type:

| Area | Prefix | Who |
|---|---|---|
| Business app | `/api/app` | Tenant staff. Each route also checks RBAC permissions and plan features. |
| Customer portal | `/api/portal` | Customer users. They only see their own records. |
| Platform | `/api/platform` | Super Admin |
| Public | `/api/public` | No login. Access is by unguessable signed tokens, for example invoice links and asset QR codes. |
| Webhooks | `/api/webhooks` | Payment, billing and WhatsApp providers. Requests are signature-verified. |

## Conventions

- **Lists** accept `page` (default 1), `pageSize` (default 25, max 200), `q` (search), `sort` (whitelisted per resource), plus resource-specific filters. They return `{ data: [...], meta: { page, pageSize, total, totalPages } }`.
- **Single resources** return `{ data: {...} }`.
- **Money** is integer minor units (paise or cents) with a `currency` field.
- **Timestamps** are ISO 8601 in UTC. Scheduling uses the tenant time zone.
- **Exports**: list and report endpoints accept `format=csv`. CSV cells are protected against formula injection. Financial documents have `/pdf` endpoints.
- **Rate limits**: login, registration and password endpoints are tightly limited. Everything else uses a general per-IP limit. Over the limit, the API returns `429 RATE_LIMITED`.

### Errors

Every error uses the same shape:

```json
{ "error": { "code": "SCHEDULE_CONFLICT", "message": "This technician already has a job in that time slot.", "details": {}, "requestId": "…" } }
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Validation failed. `details` holds the field errors. |
| 400 | `INVALID_REFERENCE` | A referenced record doesn't exist or belongs to another tenant. |
| 401 | `UNAUTHORIZED` | Missing or expired token |
| 402 | `SUBSCRIPTION_REQUIRED` / `FEATURE_NOT_IN_PLAN` | Plan does not include the feature, or the account is read-only (expired or suspended) |
| 403 | `PLAN_LIMIT` | A plan limit was reached, for example users, technicians or branches |
| 403 | `FORBIDDEN` | Missing permission |
| 404 | `NOT_FOUND` | Not found, or not visible to this user |
| 409 | `DUPLICATE` | Unique constraint, for example a duplicate customer phone |
| 409 | `SCHEDULE_CONFLICT` | Overlapping technician assignment |
| 422 | `INVALID_TRANSITION` | Work order status change not allowed |
| 422 | `BUSINESS_RULE` | For example insufficient stock, or editing an issued invoice |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL` | Unexpected error. Quote the `requestId` to support. |

### Webhooks

| Endpoint | Purpose |
|---|---|
| `POST /api/webhooks/payments/:provider/:tenantId` | Customer payment events (Razorpay or Stripe). The signature is verified with that tenant's webhook secret. |
| `POST /api/webhooks/billing/:provider` | SaaS subscription billing events |
| `GET/POST /api/webhooks/whatsapp/:tenantId` | Meta verification handshake, delivery statuses and inbound messages |

Every event is recorded in `webhook_events` by provider event id, so repeated deliveries are ignored. The exact webhook URL for each tenant is shown under **the Integrations page**.

## Endpoints

This list is generated from the route definitions. Request bodies are validated with zod schemas next to each route in `server/src/modules/<module>/routes.ts`.

### Authentication

| Method | Path |
|---|---|
| DELETE | `/api/auth/sessions/:id` |
| GET | `/api/auth/invitation` |
| GET | `/api/auth/me` |
| GET | `/api/auth/sessions` |
| PATCH | `/api/auth/profile` |
| POST | `/api/auth/accept-invite` |
| POST | `/api/auth/change-password` |
| POST | `/api/auth/forgot-password` |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| POST | `/api/auth/mfa/disable` |
| POST | `/api/auth/mfa/enable` |
| POST | `/api/auth/mfa/setup` |
| POST | `/api/auth/mfa/verify` |
| POST | `/api/auth/portal/register` |
| POST | `/api/auth/refresh` |
| POST | `/api/auth/register` |
| POST | `/api/auth/resend-verification` |
| POST | `/api/auth/reset-password` |
| POST | `/api/auth/verify-email` |

### Public (no auth)

| Method | Path |
|---|---|
| GET | `/api/public/assets/:qrToken` |
| GET | `/api/public/files/:token` |
| GET | `/api/public/invoices/:token` |
| GET | `/api/public/invoices/:token/pdf` |
| GET | `/api/public/pay/test/:intentId` |
| GET | `/api/public/plans` |
| GET | `/api/public/quotations/:token` |
| GET | `/api/public/quotations/:token/pdf` |
| GET | `/api/public/tenants/:slug` |
| POST | `/api/public/invoices/:token/pay` |
| POST | `/api/public/pay/test/:intentId` |
| POST | `/api/public/pay/test/billing/:invoiceId` |
| POST | `/api/public/quotations/:token/approve` |
| POST | `/api/public/quotations/:token/reject` |
| POST | `/api/public/tenants/:slug/requests` |

### Customer portal

| Method | Path |
|---|---|
| DELETE | `/api/portal/addresses/:id` |
| GET | `/api/portal/assets` |
| GET | `/api/portal/contracts` |
| GET | `/api/portal/invoices` |
| GET | `/api/portal/invoices/:id` |
| GET | `/api/portal/invoices/:id/pdf` |
| GET | `/api/portal/jobs` |
| GET | `/api/portal/jobs/:id` |
| GET | `/api/portal/me` |
| GET | `/api/portal/payments/:id/receipt.pdf` |
| GET | `/api/portal/quotations` |
| GET | `/api/portal/quotations/:id` |
| GET | `/api/portal/quotations/:id/pdf` |
| GET | `/api/portal/requests` |
| GET | `/api/portal/tickets` |
| PATCH | `/api/portal/addresses/:id` |
| PATCH | `/api/portal/me` |
| POST | `/api/portal/addresses` |
| POST | `/api/portal/assets` |
| POST | `/api/portal/assistant` |
| POST | `/api/portal/invoices/:id/pay` |
| POST | `/api/portal/jobs/:id/change-request` |
| POST | `/api/portal/jobs/:id/feedback` |
| POST | `/api/portal/quotations/:id/approve` |
| POST | `/api/portal/quotations/:id/reject` |
| POST | `/api/portal/requests` |
| POST | `/api/portal/tickets` |
| POST | `/api/portal/tickets/:id/messages` |

### Super Admin platform

| Method | Path |
|---|---|
| GET | `/api/platform/announcements` |
| GET | `/api/platform/audit-logs` |
| GET | `/api/platform/billing/events` |
| GET | `/api/platform/billing/invoices` |
| GET | `/api/platform/health` |
| GET | `/api/platform/overview` |
| GET | `/api/platform/plans` |
| GET | `/api/platform/settings` |
| GET | `/api/platform/tenants` |
| GET | `/api/platform/tenants/:id` |
| GET | `/api/platform/tickets` |
| PATCH | `/api/platform/announcements/:id` |
| PATCH | `/api/platform/plans/:id` |
| PATCH | `/api/platform/tenants/:id/subscription` |
| POST | `/api/platform/announcements` |
| POST | `/api/platform/billing/invoices/:id/mark-paid` |
| POST | `/api/platform/billing/invoices/:id/void` |
| POST | `/api/platform/jobs/:id/retry` |
| POST | `/api/platform/plans` |
| POST | `/api/platform/tenants/:id/reactivate` |
| POST | `/api/platform/tenants/:id/support-session` |
| POST | `/api/platform/tenants/:id/suspend` |
| POST | `/api/platform/tickets/:id/messages` |
| PUT | `/api/platform/settings/:key` |

### Webhooks (signature-verified, raw body)

| Method | Path |
|---|---|
| GET | `/api/webhooks/whatsapp/:tenantId` |
| POST | `/api/webhooks/billing/:provider` |
| POST | `/api/webhooks/payments/:provider/:tenantId` |
| POST | `/api/webhooks/whatsapp/:tenantId` |

### /api/app/ai

| Method | Path |
|---|---|
| GET | `/api/app/ai/insights` |
| GET | `/api/app/ai/schedule/:workOrderId` |
| GET | `/api/app/ai/status` |
| GET | `/api/app/ai/usage` |
| POST | `/api/app/ai/interpret` |
| POST | `/api/app/ai/service-report/:workOrderId` |

### /api/app/amc

| Method | Path |
|---|---|
| GET | `/api/app/amc` |
| GET | `/api/app/amc/:id` |
| GET | `/api/app/amc/visits/upcoming` |
| PATCH | `/api/app/amc/:id` |
| POST | `/api/app/amc` |
| POST | `/api/app/amc/:id/activate` |
| POST | `/api/app/amc/:id/cancel` |
| POST | `/api/app/amc/:id/renew` |
| POST | `/api/app/amc/visits/:visitId/work-order` |

### /api/app/assets

| Method | Path |
|---|---|
| GET | `/api/app/assets` |
| GET | `/api/app/assets/:id` |
| GET | `/api/app/assets/:id/qr.png` |
| PATCH | `/api/app/assets/:id` |
| POST | `/api/app/assets` |
| POST | `/api/app/assets/:id/replace` |

### /api/app/audit-logs

| Method | Path |
|---|---|
| GET | `/api/app/audit-logs` |

### /api/app/calendar

| Method | Path |
|---|---|
| GET | `/api/app/calendar` |

### /api/app/customers

| Method | Path |
|---|---|
| DELETE | `/api/app/customers/:id` |
| DELETE | `/api/app/customers/:id/addresses/:addressId` |
| GET | `/api/app/customers` |
| GET | `/api/app/customers/:id` |
| GET | `/api/app/customers/export` |
| PATCH | `/api/app/customers/:id` |
| PATCH | `/api/app/customers/:id/addresses/:addressId` |
| POST | `/api/app/customers` |
| POST | `/api/app/customers/:id/addresses` |
| POST | `/api/app/customers/:id/archive` |
| POST | `/api/app/customers/:id/communications` |
| POST | `/api/app/customers/:id/restore` |
| POST | `/api/app/customers/check-duplicates` |
| POST | `/api/app/customers/import` |

### /api/app/dashboard

| Method | Path |
|---|---|
| GET | `/api/app/dashboard` |

### /api/app/dispatch

| Method | Path |
|---|---|
| GET | `/api/app/dispatch/board` |
| GET | `/api/app/dispatch/suggestions/:workOrderId` |

### /api/app/documents

| Method | Path |
|---|---|
| DELETE | `/api/app/documents/:id` |
| GET | `/api/app/documents` |
| GET | `/api/app/documents/:id/download` |
| POST | `/api/app/documents` |
| POST | `/api/app/documents/:id/link` |

### /api/app/integrations

| Method | Path |
|---|---|
| GET | `/api/app/integrations` |
| POST | `/api/app/integrations/:kind/test` |
| PUT | `/api/app/integrations/:kind` |

### /api/app/inventory

| Method | Path |
|---|---|
| GET | `/api/app/inventory/items` |
| GET | `/api/app/inventory/items/:id` |
| GET | `/api/app/inventory/locations` |
| GET | `/api/app/inventory/low-stock` |
| GET | `/api/app/inventory/purchases` |
| GET | `/api/app/inventory/suppliers` |
| PATCH | `/api/app/inventory/items/:id` |
| PATCH | `/api/app/inventory/suppliers/:id` |
| POST | `/api/app/inventory/adjustments` |
| POST | `/api/app/inventory/items` |
| POST | `/api/app/inventory/purchases` |
| POST | `/api/app/inventory/suppliers` |
| POST | `/api/app/inventory/transfers` |

### /api/app/invoices

| Method | Path |
|---|---|
| DELETE | `/api/app/invoices/:id` |
| GET | `/api/app/invoices` |
| GET | `/api/app/invoices/:id` |
| GET | `/api/app/invoices/:id/pdf` |
| POST | `/api/app/invoices` |
| POST | `/api/app/invoices/:id/cancel` |
| POST | `/api/app/invoices/:id/credit-notes` |
| POST | `/api/app/invoices/:id/issue` |
| POST | `/api/app/invoices/:id/payment-link` |
| POST | `/api/app/invoices/:id/send` |
| PUT | `/api/app/invoices/:id` |

### /api/app/notifications

| Method | Path |
|---|---|
| DELETE | `/api/app/notifications/templates/:event/:channel` |
| GET | `/api/app/notifications/inbox` |
| GET | `/api/app/notifications/logs` |
| GET | `/api/app/notifications/logs/:id` |
| GET | `/api/app/notifications/templates` |
| POST | `/api/app/notifications/inbox/read` |
| POST | `/api/app/notifications/logs/:id/retry` |
| POST | `/api/app/notifications/templates/preview` |
| PUT | `/api/app/notifications/templates` |

### /api/app/payments

| Method | Path |
|---|---|
| GET | `/api/app/payments` |
| GET | `/api/app/payments/:id/receipt.pdf` |
| POST | `/api/app/payments` |
| POST | `/api/app/payments/:id/confirm` |
| POST | `/api/app/payments/:id/fail` |
| POST | `/api/app/payments/:id/refund` |
| POST | `/api/app/payments/reconcile` |

### /api/app/privacy

| Method | Path |
|---|---|
| GET | `/api/app/privacy/requests` |
| POST | `/api/app/privacy/requests` |
| POST | `/api/app/privacy/requests/:id/complete` |

### /api/app/quotations

| Method | Path |
|---|---|
| DELETE | `/api/app/quotations/:id` |
| GET | `/api/app/quotations` |
| GET | `/api/app/quotations/:id` |
| GET | `/api/app/quotations/:id/pdf` |
| POST | `/api/app/quotations` |
| POST | `/api/app/quotations/:id/approve` |
| POST | `/api/app/quotations/:id/reject` |
| POST | `/api/app/quotations/:id/revise` |
| POST | `/api/app/quotations/:id/send` |
| PUT | `/api/app/quotations/:id` |

### /api/app/reports

| Method | Path |
|---|---|
| GET | `/api/app/reports` |
| GET | `/api/app/reports/:key` |

### /api/app/requests

| Method | Path |
|---|---|
| GET | `/api/app/requests` |
| GET | `/api/app/requests/:id` |
| PATCH | `/api/app/requests/:id` |
| POST | `/api/app/requests` |
| POST | `/api/app/requests/:id/convert` |
| POST | `/api/app/requests/:id/status` |

### /api/app/search

| Method | Path |
|---|---|
| GET | `/api/app/search` |

### /api/app/settings

| Method | Path |
|---|---|
| DELETE | `/api/app/settings/support-access/:id` |
| GET | `/api/app/settings` |
| GET | `/api/app/settings/onboarding/presets` |
| GET | `/api/app/settings/support-access` |
| PATCH | `/api/app/settings` |
| PATCH | `/api/app/settings/branches/:id` |
| PATCH | `/api/app/settings/profile` |
| POST | `/api/app/settings/branches` |
| POST | `/api/app/settings/onboarding` |
| POST | `/api/app/settings/support-access` |

### /api/app/subscription

| Method | Path |
|---|---|
| GET | `/api/app/subscription` |
| GET | `/api/app/subscription/support-tickets` |
| POST | `/api/app/subscription/cancel` |
| POST | `/api/app/subscription/change-plan` |
| POST | `/api/app/subscription/checkout` |
| POST | `/api/app/subscription/resume` |
| POST | `/api/app/subscription/support-tickets` |
| POST | `/api/app/subscription/support-tickets/:id/messages` |

### /api/app/support

| Method | Path |
|---|---|
| GET | `/api/app/support/feedback` |
| GET | `/api/app/support/tickets` |
| GET | `/api/app/support/tickets/:id` |
| PATCH | `/api/app/support/tickets/:id` |
| POST | `/api/app/support/feedback/:id/review` |
| POST | `/api/app/support/tickets` |
| POST | `/api/app/support/tickets/:id/messages` |

### /api/app/technicians

| Method | Path |
|---|---|
| DELETE | `/api/app/technicians/:id/time-off/:offId` |
| GET | `/api/app/technicians` |
| GET | `/api/app/technicians/:id` |
| GET | `/api/app/technicians/:id/schedule` |
| GET | `/api/app/technicians/me/dashboard` |
| GET | `/api/app/technicians/me/history` |
| PATCH | `/api/app/technicians/:id` |
| POST | `/api/app/technicians` |
| POST | `/api/app/technicians/:id/time-off` |
| POST | `/api/app/technicians/me/attendance` |
| PUT | `/api/app/technicians/:id/areas` |
| PUT | `/api/app/technicians/:id/availability` |
| PUT | `/api/app/technicians/:id/skills` |

### /api/app/users

| Method | Path |
|---|---|
| GET | `/api/app/users` |
| GET | `/api/app/users/roles` |
| PATCH | `/api/app/users/:id` |
| POST | `/api/app/users` |
| POST | `/api/app/users/:id/activate` |
| POST | `/api/app/users/:id/deactivate` |
| POST | `/api/app/users/:id/resend-invite` |
| POST | `/api/app/users/roles` |
| PUT | `/api/app/users/roles/:id` |

### /api/app/work-orders

| Method | Path |
|---|---|
| DELETE | `/api/app/work-orders/:id/labour/:labourId` |
| DELETE | `/api/app/work-orders/:id/parts/:partId` |
| GET | `/api/app/work-orders` |
| GET | `/api/app/work-orders/:id` |
| GET | `/api/app/work-orders/board` |
| PATCH | `/api/app/work-orders/:id` |
| POST | `/api/app/work-orders` |
| POST | `/api/app/work-orders/:id/accept` |
| POST | `/api/app/work-orders/:id/assign` |
| POST | `/api/app/work-orders/:id/labour` |
| POST | `/api/app/work-orders/:id/notes` |
| POST | `/api/app/work-orders/:id/parts` |
| POST | `/api/app/work-orders/:id/reschedule` |
| POST | `/api/app/work-orders/:id/signature` |
| POST | `/api/app/work-orders/:id/status` |
| POST | `/api/app/work-orders/:id/unassign` |
| POST | `/api/app/work-orders/bulk` |
| PUT | `/api/app/work-orders/:id/report` |
