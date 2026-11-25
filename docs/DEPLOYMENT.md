# Deployment (Railway)

ServiceFlow deploys as **one web service**, a **PostgreSQL** database and an **S3-compatible bucket**. The repository's `railway.json` already configures the build and health check:

- **Build:** Railpack runs `npm install --include=dev --no-audit --no-fund && npm run build`.
- **Start:** `npm start`. On boot this applies migrations, ensures reference data and the Super Admin, optionally seeds the demo, starts the worker, then listens on `PORT`.
- **Health check:** `GET /api/health`. `GET /api/health/ready` also checks the database.

## Railway project `magnificent-beauty`

| Resource | Notes |
|---|---|
| Service `ServiceFlow` | Builds from the GitHub repo. Public domain is `serviceflow-production-ed951e90.up.railway.app`. |
| `Postgres` | Railway Postgres template, with a persistent volume |
| Bucket `serviceflow-files` | S3-compatible storage for uploads, signatures, photos and PDFs |

## Required service variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private network) |
| `NODE_ENV` | `production` |
| `APP_URL` | `https://<your domain>` |
| `JWT_SECRET` | 48+ random characters |
| `ENCRYPTION_KEY` | 64 hex chars. **Back this up.** Losing it makes stored integration secrets and MFA seeds unreadable. |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `${{serviceflow-files.ENDPOINT}}`, `${{serviceflow-files.BUCKET}}`, and so on |
| `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` | Super Admin login. Change the password after the first sign-in. |
| `TRUST_PROXY` | `1` |

Optional variables:

- `SEED_DEMO=true`. Seeds the CoolCare demo tenant once.
- `BILLING_PROVIDER`
- `EMAIL_DRIVER` and the `SMTP_*` variables
- `AI_PROVIDER` and `ANTHROPIC_API_KEY`
- `MAPS_PROVIDER` and `GOOGLE_MAPS_API_KEY`
- `SENTRY_DSN`

See [`.env.example`](../.env.example).

## Deploy steps (fresh project)

1. Create the project, add the **Postgres** template, and add a **Bucket**.
2. Create a service from the GitHub repo and choose the branch to deploy.
3. Set the variables above.
4. Generate a domain, then set `APP_URL` to it.
5. Deploy. Watch the deploy logs for `migrations applied` and `NEXUS ServiceFlow API listening`.
6. Open `/api/health/ready`. It reports `database`, `storage` and `queue` checks, and all three should be `ok`.
7. Sign in at `/login` as the Super Admin and change the password.

**Scaling.** You can run more than one replica: scheduler tasks take advisory locks and queue claims use `SKIP LOCKED`. For heavy load, run a second service with the same variables and `RUN_WORKER=true`, and set `RUN_WORKER=false` on the web replicas.

## Going live with integrations

Every integration runs in a safe mode until you provide credentials.

| Integration | Where | What you need |
|---|---|---|
| Platform email | env | `EMAIL_DRIVER=smtp`, `SMTP_HOST/PORT/USER/PASS` and `EMAIL_FROM` on a domain with SPF and DKIM set up |
| WhatsApp | Tenant → Integrations page | Meta Business account, WhatsApp Cloud API phone number ID, permanent access token, app secret, a verify token, and **approved message templates**. Set the webhook URL shown in the app in the Meta developer console. |
| SMS | Tenant → Integrations | Twilio account SID, auth token and sender number. India also needs DLT registration. |
| Customer payments | Tenant → Integrations | Razorpay key ID, key secret and webhook secret, **or** Stripe secret key and webhook signing secret. Register the webhook URL shown in the app. Switch the mode from `test` to `live`. |
| SaaS billing | env | `BILLING_PROVIDER=stripe` or `razorpay`, plus `BILLING_KEY_ID`, `BILLING_SECRET_KEY` and `BILLING_WEBHOOK_SECRET`. Webhook URL is `<APP_URL>/api/webhooks/billing/<provider>`. |
| AI | env | `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. Usage is metered per tenant against plan quotas. |
| Maps | env | `MAPS_PROVIDER=google` and `GOOGLE_MAPS_API_KEY`. The default is OpenStreetMap, which needs no key. |

## Production checklist

- [ ] Strong unique `JWT_SECRET` and `ENCRYPTION_KEY`. Store the encryption key in a password manager.
- [ ] Super Admin password changed after the first login. MFA enabled.
- [ ] `SEED_DEMO` unset or `false` for real customer environments. If the demo tenant is not needed, suspend it from the Super Admin console.
- [ ] SMTP configured, so verification and password reset emails actually arrive.
- [ ] Backups verified. See [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
- [ ] Custom domain added, with `APP_URL` updated.
- [ ] Terms of service, privacy policy and DPA reviewed by a lawyer for your markets.
