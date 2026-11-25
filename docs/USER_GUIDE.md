# User guide

ServiceFlow has four workspaces. Each person sees only the menus their role allows.

| Workspace | URL | Who |
|---|---|---|
| Business app | `/app` | Owners, admins, managers, dispatchers, accountants |
| Technician app | `/tech` | Field technicians. Built for phones. |
| Customer portal | `/portal/<workspace>/login` | Your customers |
| Platform console | `/platform` | NEXUS Super Admins |

## Getting started (owner)

1. **Register** at `/register` with your business name, country, phone and email, then verify your email. Your 14-day trial starts automatically.
2. **Onboarding.** The wizard asks for:
   - your company profile and tax registration (GSTIN/VAT)
   - business hours
   - service categories
   - your first team members
   - invoice and quotation numbering
3. **Invite your team** under **Settings → Users**. Pick a role for each person. Invitations expire after 7 days.
4. **Connect channels** on the **Integrations** page (WhatsApp, SMS, payment gateway). Until you do, notifications are logged and payments use test mode.

## Daily workflow

**Customer → Request → Work order → Dispatch → Field work → Quotation/Invoice → Payment**

- **Customers** (`/app/customers`)
  - Add customers with addresses, contacts and notes. Duplicate phone numbers and emails are detected.
  - Each customer page shows assets, jobs, quotations, invoices, AMC contracts and a timeline.
- **Assets.** Register equipment such as AC units, inverters and CCTV, with serial numbers and warranty dates. Print the asset's **QR label**: scanning it opens the service history and a "request service" form.
- **Service requests.** Requests arrive from the portal, the QR code, or staff entry. Triage a request, then **convert it to a work order**.
- **Work orders.** These move through statuses: new → approved → scheduled → assigned → en route → in progress (↔ on hold) → completed → invoiced → paid. A job can also be cancelled or rejected. The system blocks invalid jumps, and technicians can only move their own jobs.
- **Dispatch** (`/app/dispatch`)
  - A day board shows technicians, unassigned jobs and suggestions based on skills, zone and workload.
  - Assignments can't overlap. If a slot is already taken, you'll see a conflict message.
- **Calendar.** Shows the week or month view of all jobs, AMC visits and technician leave.

## Technician app (`/tech`)

1. Open **Today's jobs**. Tap a job to see the address (with a map link), the customer and the asset history.
2. Update the status with **On my way**, **Start**, **Pause** and **Complete**.
3. Add a checklist, findings, photos, the parts used (from van stock) and the customer's **signature**.
4. Complete the job. The office is notified, and an invoice or quotation can be raised straight away.

## Money

- **Quotations**
  - Build a quotation from parts and services with tax.
  - Send it as a link or PDF. The customer can approve or reject it online.
  - Editing a sent quotation creates a **revision**.
  - An approved quotation can become a work order or an invoice.
- **Invoices**
  - Invoices apply GST (CGST+SGST or IGST) or VAT according to your country settings.
  - Once **issued**, an invoice cannot be edited. Use a **credit note** to correct it.
  - Overdue reminders go out automatically.
- **Payments**
  - Record cash, UPI, bank transfer or cheque payments yourself, or let customers pay online through the invoice link.
  - Partial payments and refunds are supported.
  - Online payments are confirmed by the gateway's signed webhook, never by the browser.
- **Inventory.** Manage items, warehouses, technician van stock, transfers, adjustments, purchase receipts and low-stock alerts. Parts used on jobs are deducted automatically.
- **AMC contracts.** Set up annual maintenance plans for a customer's assets. Preventive visits are generated as work orders on schedule, and renewals are flagged ahead of expiry.

## Customers (portal)

Customers can:

- sign in or register on your workspace portal
- view their equipment and its service history
- raise service requests and track job status
- approve quotations
- download and pay invoices
- review AMC contracts
- leave feedback

## Reports and AI

- **Reports** (`/app/reports`) covers revenue, collections, outstanding and aging, jobs by status and category, technician performance, first-time fix rate, SLA, AMC, inventory valuation, customer growth and more. Every report has date filters and **CSV/PDF export**.
- **AI assistant** (on plans that include it) can:
  - summarise a job
  - suggest a diagnosis
  - draft customer messages
  - suggest technicians
  - answer questions about your data

  AI output is a suggestion. You review it before anything is saved.

## Administration

- **Settings**
  - company profile, branches, tax, numbering and templates
  - users and roles (custom roles on higher plans)
  - notification preferences
  - privacy requests: export, rectification and erasure
  - the audit log
- **Subscription.** See your plan, usage against limits and invoices, then upgrade or renew. If a subscription lapses, the account becomes read-only. Your data is never deleted for non-payment.
- **Security.** Turn on two-factor authentication under **Profile**, where you can also review and sign out other sessions.

## Super Admin (`/platform`)

The platform console lets a Super Admin:

- see platform metrics: tenants, MRR, growth and failed jobs
- manage tenants: suspend, reactivate, change plan or trial
- edit plans and prices
- handle support tickets
- open read-only support sessions, which need a grant from the tenant
- retry dead background jobs
- view platform audit logs
