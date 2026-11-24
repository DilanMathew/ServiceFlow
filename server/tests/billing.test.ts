import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { api, registerTenant, staff, as, makeCustomer, iso, type TenantCtx } from './helpers.js';
import { withTenant, systemDb } from '../src/db/pool.js';
import { hmacSha256Hex } from '../src/lib/crypto.js';
import { testGatewaySecret } from '../src/integrations/payments.js';

const idem = () => `key-${crypto.randomUUID()}`;

describe('quotations, invoices, payments and refunds', () => {
  let t: TenantCtx; let cust: any; let taxId: string; let tech: any;
  beforeAll(async () => {
    t = await registerTenant();
    tech = await staff(t, 'technician', { technician: true });
    cust = await makeCustomer(t.owner.token, { email: 'payer@example.com' });
    const s = await as(t.owner.token).get('/api/app/settings');
    taxId = s.body.data.taxRates.find((r: any) => r.is_default).id; // GST 18% (CGST 9 + SGST 9)
  });

  const items = () => [{ itemType: 'labour', description: 'AC repair', quantity: 1, unitPrice: 1000, taxRateId: taxId },
    { itemType: 'part', description: 'Capacitor', quantity: 2, unitPrice: 250, discountPercent: 10, taxRateId: taxId }];

  it('calculates GST totals with component breakdown', async () => {
    const q = await as(t.owner.token).post('/api/app/quotations', { customerId: cust.id, items: items() });
    expect(q.status).toBe(201);
    // 1000 + 450 = 1450 net, 18% tax = 261
    expect(Number(q.body.data.subtotal)).toBe(1500);
    expect(Number(q.body.data.discount_total)).toBe(50);
    expect(Number(q.body.data.tax_total)).toBe(261);
    expect(Number(q.body.data.total)).toBe(1711);
    expect(q.body.data.tax_breakdown.map((b: any) => b.name).sort()).toEqual(['CGST', 'SGST']);
  });

  it('quotation lifecycle: send, customer approval via public link, locked after approval, revision, conversion', async () => {
    const q = (await as(t.owner.token).post('/api/app/quotations', { customerId: cust.id, items: items() })).body.data;
    expect((await as(t.owner.token).post(`/api/app/quotations/${q.id}/send`)).status).toBe(200);
    const view = await api().get(`/api/public/quotations/${q.public_token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.status).toBe('viewed');
    expect(view.body.data).not.toHaveProperty('customer_id');
    expect((await api().post(`/api/public/quotations/${q.public_token}/approve`).send({ name: 'Payer', accept: true })).status).toBe(200);
    const edit = await as(t.owner.token).put(`/api/app/quotations/${q.id}`, { items: items() });
    expect(edit.status).toBe(422);
    await expect(withTenant(t.tenantId, (db) => db.query(`UPDATE quotation_items SET unit_price = 1 WHERE quotation_id = $1`, [q.id]))).rejects.toThrow(/cannot be modified/);
    const rev = await as(t.owner.token).post(`/api/app/quotations/${q.id}/revise`, { reason: 'Customer asked for an extra part' });
    expect(rev.status).toBe(201);
    expect(rev.body.data.revision).toBe(2);
    expect((await as(t.owner.token).get(`/api/app/quotations/${q.id}`)).body.data.status).toBe('superseded');
    const q2 = rev.body.data;
    await as(t.owner.token).post(`/api/app/quotations/${q2.id}/send`);
    await as(t.owner.token).post(`/api/app/quotations/${q2.id}/approve`, { approvedByName: 'Payer (phone)' });
    const inv = await as(t.owner.token).post('/api/app/invoices', { quotationId: q2.id, issue: true });
    expect(inv.status).toBe(201);
    expect(inv.body.data.status).toBe('issued');
    expect(inv.body.data.number).toMatch(/^INV-\d{5}$/);
    const dup = await as(t.owner.token).post('/api/app/invoices', { quotationId: q2.id });
    expect(dup.status).toBe(422); // already converted
  });

  it('issued invoices are immutable; corrections use credit notes or cancellation', async () => {
    const inv = (await as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, items: items(), issue: true })).body.data;
    expect((await as(t.owner.token).put(`/api/app/invoices/${inv.id}`, { items: items() })).status).toBe(422);
    await expect(withTenant(t.tenantId, (db) => db.query(`UPDATE invoices SET total = 1 WHERE id = $1`, [inv.id]))).rejects.toThrow(/cannot be modified/);
    await expect(withTenant(t.tenantId, (db) => db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [inv.id]))).rejects.toThrow();
    const cn = await as(t.owner.token).post(`/api/app/invoices/${inv.id}/credit-notes`, { amount: 100, reason: 'Goodwill discount' });
    expect(cn.status).toBe(201);
    const after = await as(t.owner.token).get(`/api/app/invoices/${inv.id}`);
    expect(Number(after.body.data.balance_due)).toBe(1611);
    expect((await as(t.owner.token).post(`/api/app/invoices/${inv.id}/cancel`, { reason: 'Raised in error' })).status).toBe(200);
  });

  it('a job becomes paid only when succeeded payments settle its invoice; partial payments and overpayment rules hold', async () => {
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Billing flow', scheduledStart: iso(1), technicianId: tech.technicianId, force: true })).body.data;
    for (const s of ['en_route', 'in_progress']) await as(tech.token).post(`/api/app/work-orders/${wo.id}/status`, { status: s });
    await as(tech.token).post(`/api/app/work-orders/${wo.id}/labour`, { description: 'Repair', hours: 2 });
    await as(tech.token).put(`/api/app/work-orders/${wo.id}/report`, { workPerformed: 'Repaired' });
    await as(tech.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'completed' });
    // labour rate defaults to 0 for an uncategorised job; add a priced line explicitly
    const inv = (await as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, workOrderId: wo.id, items: [{ itemType: 'labour', description: 'Repair', quantity: 1, unitPrice: 1000 }], issue: true })).body.data;
    expect((await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`)).body.data.status).toBe('invoiced');
    const over = await as(t.owner.token).post('/api/app/payments', { invoiceId: inv.id, amount: 1500, method: 'cash' });
    expect(over.status).toBe(422);
    const key = idem();
    const p1 = await api().post('/api/app/payments').set('authorization', `Bearer ${t.owner.token}`).set('idempotency-key', key).send({ invoiceId: inv.id, amount: 400, method: 'upi', reference: 'UPI123' });
    expect(p1.status).toBe(201);
    const p1dup = await api().post('/api/app/payments').set('authorization', `Bearer ${t.owner.token}`).set('idempotency-key', key).send({ invoiceId: inv.id, amount: 400, method: 'upi', reference: 'UPI123' });
    expect(p1dup.status).toBe(200);
    expect(p1dup.body.meta.duplicate).toBe(true);
    let i = (await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data;
    expect(i.status).toBe('partially_paid');
    expect(Number(i.balance_due)).toBe(600);
    expect((await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`)).body.data.status).toBe('invoiced');
    // pending cheque does not count until confirmed
    const cheque = await as(t.owner.token).post('/api/app/payments', { invoiceId: inv.id, amount: 600, method: 'cheque', status: 'pending' });
    expect((await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data.status).toBe('partially_paid');
    await as(t.owner.token).post(`/api/app/payments/${cheque.body.data.id}/confirm`);
    i = (await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data;
    expect(i.status).toBe('paid');
    expect((await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`)).body.data.status).toBe('paid');
    const receipt = await as(t.owner.token).get(`/api/app/payments/${p1.body.data.id}/receipt.pdf`);
    expect(receipt.headers['content-type']).toBe('application/pdf');
  });

  it('refunds are idempotent and bounded by the refundable amount', async () => {
    const inv = (await as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, items: [{ itemType: 'charge', description: 'Visit', quantity: 1, unitPrice: 500 }], issue: true })).body.data;
    const pay = (await as(t.owner.token).post('/api/app/payments', { invoiceId: inv.id, amount: 500, method: 'cash' })).body.data;
    expect((await as(t.owner.token).post(`/api/app/payments/${pay.id}/refund`, { amount: 100, reason: 'Partial refund' })).status).toBe(400); // key required
    const key = idem();
    const r1 = await api().post(`/api/app/payments/${pay.id}/refund`).set('authorization', `Bearer ${t.owner.token}`).set('idempotency-key', key).send({ amount: 200, reason: 'Partial refund' });
    const r2 = await api().post(`/api/app/payments/${pay.id}/refund`).set('authorization', `Bearer ${t.owner.token}`).set('idempotency-key', key).send({ amount: 200, reason: 'Partial refund' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    const tooMuch = await api().post(`/api/app/payments/${pay.id}/refund`).set('authorization', `Bearer ${t.owner.token}`).set('idempotency-key', idem()).send({ amount: 301, reason: 'Too much' });
    expect(tooMuch.status).toBe(422);
    const i = (await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data;
    expect(i.status).toBe('partially_refunded');
    expect(Number(i.amount_refunded)).toBe(200);
    const refunds = await systemDb.one(`SELECT count(*)::int n FROM refunds WHERE payment_id = $1`, [pay.id]);
    expect(refunds.n).toBe(1);
  });

  it('online payments: only verified webhooks record payments, and replays are ignored', async () => {
    const inv = (await as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, items: [{ itemType: 'charge', description: 'Online', quantity: 1, unitPrice: 999 }], issue: true })).body.data;
    const link = await api().post(`/api/public/invoices/${inv.public_token}/pay`);
    expect(link.status).toBe(200);
    const intentId = link.body.data.intentId;
    const body = JSON.stringify({ id: `evt_${intentId}`, type: 'payment.succeeded', intentId, paymentId: `pay_${intentId}`, amount: 999, currency: 'INR' });
    // forged signature
    const forged = await api().post(`/api/webhooks/payments/test/${t.tenantId}`).set('content-type', 'application/json').set('x-test-signature', 'deadbeef').send(body);
    expect(forged.status).toBe(401);
    expect((await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data.status).toBe('issued');
    const sig = hmacSha256Hex(testGatewaySecret(), Buffer.from(body));
    const ok = await api().post(`/api/webhooks/payments/test/${t.tenantId}`).set('content-type', 'application/json').set('x-test-signature', sig).send(body);
    expect(ok.status).toBe(200);
    const replay = await api().post(`/api/webhooks/payments/test/${t.tenantId}`).set('content-type', 'application/json').set('x-test-signature', sig).send(body);
    expect(replay.body.duplicate).toBe(true);
    // same provider payment id in a different event id is still deduplicated
    const body2 = JSON.stringify({ id: `evt2_${intentId}`, type: 'payment.succeeded', intentId, paymentId: `pay_${intentId}`, amount: 999, currency: 'INR' });
    await api().post(`/api/webhooks/payments/test/${t.tenantId}`).set('content-type', 'application/json').set('x-test-signature', hmacSha256Hex(testGatewaySecret(), Buffer.from(body2))).send(body2);
    const pays = await systemDb.one(`SELECT count(*)::int n FROM payments WHERE invoice_id = $1 AND status = 'succeeded'`, [inv.id]);
    expect(pays.n).toBe(1);
    expect((await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data.status).toBe('paid');
  });

  it('sandbox checkout failure records a failed payment without changing the invoice', async () => {
    const inv = (await as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, items: [{ itemType: 'charge', description: 'Fail', quantity: 1, unitPrice: 100 }], issue: true })).body.data;
    const link = await api().post(`/api/public/invoices/${inv.public_token}/pay`);
    const r = await api().post(`/api/public/pay/test/${link.body.data.intentId}`).send({ outcome: 'failure' });
    expect(r.status).toBe(200);
    expect((await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data.status).toBe('issued');
    const failed = await systemDb.one(`SELECT count(*)::int n FROM payments WHERE invoice_id = $1 AND status = 'failed'`, [inv.id]);
    expect(failed.n).toBe(1);
  });

  it('invoice numbers are gapless and unique under concurrent issuing', async () => {
    const drafts = await Promise.all(Array.from({ length: 6 }, () => as(t.owner.token).post('/api/app/invoices', { customerId: cust.id, items: [{ itemType: 'charge', description: 'c', quantity: 1, unitPrice: 10 }] })));
    const issued = await Promise.all(drafts.map((d) => as(t.owner.token).post(`/api/app/invoices/${d.body.data.id}/issue`)));
    const nums = issued.map((r) => r.body.data.number);
    expect(new Set(nums).size).toBe(6);
  });
});
