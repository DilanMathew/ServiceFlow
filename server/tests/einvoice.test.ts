import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, as, drainJobs, type TenantCtx } from './helpers.js';
import { computeIrn, financialYear } from '../src/modules/einvoice/india.js';
import { systemDb } from '../src/db/pool.js';

// XML written here can be checked with the official KoSIT validator (see docs/EINVOICING.md).
const OUT = process.env.EINVOICE_OUT_DIR;
const save = (name: string, xml: string) => { if (OUT) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, name), xml); } };

const SELLER_GSTIN = '29AABCU9603R1ZM';
const BUYER_GSTIN = '29AAACR5055K1Z5';
const OTHER_STATE_GSTIN = '27AAACR5055K1Z7';

async function taxRate(token: string, match: (r: any) => boolean) {
  const s = await as(token).get('/api/app/settings');
  return s.body.data.taxRates.find(match).id as string;
}

describe('India GST e-invoicing (IRN)', () => {
  let t: TenantCtx; let cgst: string; let igst: string; let buyer: any; let b2c: any;
  const invoice = async (customerId: string, rateId: string, extra: object = {}) => {
    const r = await as(t.owner.token).post('/api/app/invoices', { customerId, issue: true, items: [
      { itemType: 'labour', description: 'AC service — split 1.5 TR', hsnSacCode: '998719', quantity: 1, unitPrice: 1200, taxRateId: rateId },
      { itemType: 'part', description: 'Capacitor 45 MFD', hsnSacCode: '85322200', quantity: 2, unitPrice: 350, taxRateId: rateId }], ...extra });
    expect(r.status).toBe(201);
    return r.body.data;
  };

  beforeAll(async () => {
    t = await registerTenant('EInv India');
    await as(t.owner.token).patch('/api/app/settings/profile', { name: 'CoolAir Services', legalName: 'CoolAir Services Pvt Ltd', addressLine1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001', country: 'IN', phone: '+91 80 4000 1000', email: 'billing@coolair.example' });
    await as(t.owner.token).patch('/api/app/settings', { taxRegistrationNumber: SELLER_GSTIN });
    cgst = await taxRate(t.owner.token, (r) => r.rate === '18.000' || Number(r.rate) === 18 && r.name.includes('CGST'));
    igst = await taxRate(t.owner.token, (r) => Number(r.rate) === 18 && r.name.startsWith('IGST'));
    buyer = (await as(t.owner.token).post('/api/app/customers', { customerType: 'business', fullName: 'Asha Rao', companyName: 'Rao Textiles LLP', taxId: BUYER_GSTIN,
      billingLine1: '45 Industrial Area', billingCity: 'Mysuru', billingState: 'Karnataka', billingPostalCode: '570016', billingCountry: 'IN', phone: '+91 98450 12345' })).body.data;
    b2c = (await as(t.owner.token).post('/api/app/customers', { fullName: 'Walk-in Customer', phone: '+91 90000 11111', billingLine1: '1 Main St', billingCity: 'Bengaluru', billingState: 'Karnataka', billingPostalCode: '560002' })).body.data;
  });

  it('reports what is missing before anything is submitted', async () => {
    const inv = await invoice(b2c.id, cgst);
    const r = await as(t.owner.token).get(`/api/app/einvoice/invoices/${inv.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.schemes).toEqual(['IN_IRN']);
    expect(r.body.data.readiness.IN_IRN.map((i: any) => i.field)).toContain('buyer.gstin');
    const noProvider = await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {});
    expect(noProvider.status).toBe(422);
  });

  it('flags lines without HSN/SAC and the wrong tax type for the place of supply', async () => {
    const r = await as(t.owner.token).post('/api/app/invoices', { customerId: buyer.id, issue: true, placeOfSupply: 'Maharashtra',
      items: [{ itemType: 'charge', description: 'Visit charge', quantity: 1, unitPrice: 300, taxRateId: cgst }] });
    const d = await as(t.owner.token).get(`/api/app/einvoice/invoices/${r.body.data.id}`);
    const fields = d.body.data.readiness.IN_IRN.map((i: any) => i.field);
    expect(fields).toContain('items[0].hsn');
    expect(fields).toContain('items[0].tax'); // Karnataka seller → Maharashtra POS must be IGST
  });

  it('registers an IRN through the sandbox provider, prints it on the PDF and blocks duplicates', async () => {
    expect((await as(t.owner.token).put('/api/app/integrations/einvoice', { provider: 'in_sandbox', mode: 'test', enabled: true })).status).toBe(200);
    const inv = await invoice(buyer.id, cgst);
    const ready = await as(t.owner.token).get(`/api/app/einvoice/invoices/${inv.id}`);
    expect(ready.body.data.readiness.IN_IRN).toEqual([]);
    const r = await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {});
    expect(r.status).toBe(201);
    const issued = (await as(t.owner.token).get(`/api/app/invoices/${inv.id}`)).body.data;
    expect(r.body.data.irn).toBe(computeIrn(SELLER_GSTIN, issued.issue_date, 'INV', issued.number));
    expect(r.body.data.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.data.mode).toBe('test');
    const payload = JSON.parse((await systemDb.one(`SELECT payload FROM einvoice_documents WHERE id = $1`, [r.body.data.id])).payload);
    expect(payload.Version).toBe('1.1');
    expect(payload.SellerDtls.Stcd).toBe('29');
    expect(payload.BuyerDtls.Pos).toBe('29');
    expect(payload.ItemList[0]).toMatchObject({ HsnCd: '998719', IsServc: 'Y', AssAmt: 1200, CgstAmt: 108, SgstAmt: 108, IgstAmt: 0, TotItemVal: 1416 });
    expect(payload.ItemList[1]).toMatchObject({ HsnCd: '85322200', IsServc: 'N', Qty: 2, AssAmt: 700 });
    expect(payload.ValDtls.TotInvVal).toBe(Number(issued.total));
    expect((await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {})).status).toBe(409);
    const pdf = await as(t.owner.token).get(`/api/app/invoices/${inv.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });

  it('uses IGST for inter-state supplies', async () => {
    const other = (await as(t.owner.token).post('/api/app/customers', { customerType: 'business', fullName: 'Vik', companyName: 'Pune Cooling Co', taxId: OTHER_STATE_GSTIN,
      billingLine1: '9 FC Road', billingCity: 'Pune', billingState: 'Maharashtra', billingPostalCode: '411004', billingCountry: 'IN' })).body.data;
    const inv = await invoice(other.id, igst, { placeOfSupply: 'Maharashtra' });
    const r = await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {});
    expect(r.status).toBe(201);
    const payload = JSON.parse((await systemDb.one(`SELECT payload FROM einvoice_documents WHERE id = $1`, [r.body.data.id])).payload);
    expect(payload.BuyerDtls).toMatchObject({ Stcd: '27', Pos: '27' });
    expect(payload.ValDtls.IgstVal).toBeGreaterThan(0);
    expect(payload.ValDtls.CgstVal).toBe(0);
  });

  it('registers credit notes (CRN) against the original invoice', async () => {
    const inv = await invoice(buyer.id, cgst);
    await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {});
    const cn = await as(t.owner.token).post(`/api/app/invoices/${inv.id}/credit-notes`, { amount: 590, reason: 'Capacitor returned' });
    expect(cn.status).toBe(201);
    const r = await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, { creditNoteId: cn.body.data.id });
    expect(r.status).toBe(201);
    const payload = JSON.parse((await systemDb.one(`SELECT payload FROM einvoice_documents WHERE id = $1`, [r.body.data.id])).payload);
    expect(payload.DocDtls.Typ).toBe('CRN');
    expect(payload.RefDtls.PrecDocDtls[0].InvNo).toBe(inv.number);
    expect(payload.ValDtls.TotInvVal).toBeCloseTo(590, 2);
    expect(payload.ValDtls.CgstVal + payload.ValDtls.SgstVal).toBeCloseTo(90, 1); // 590 incl. 18% → 500 + 90
  });

  it('cancels within 24 hours only', async () => {
    const inv = await invoice(buyer.id, cgst);
    const doc = (await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {})).body.data;
    const ok = await as(t.owner.token).post(`/api/app/einvoice/documents/${doc.id}/cancel`, { reasonCode: '2', remark: 'Wrong quantity' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('cancelled');
    // a cancelled IRN can be replaced by a new registration for a corrected document flow
    const inv2 = await invoice(buyer.id, cgst);
    const doc2 = (await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv2.id}/irn`, {})).body.data;
    await systemDb.query(`UPDATE einvoice_documents SET ack_date = now() - interval '25 hours' WHERE id = $1`, [doc2.id]);
    expect((await as(t.owner.token).post(`/api/app/einvoice/documents/${doc2.id}/cancel`, { reasonCode: '2', remark: 'Too late' })).status).toBe(422);
  });

  it('registers automatically on issue when enabled, and skips B2C', async () => {
    await as(t.owner.token).patch('/api/app/settings', { einvoiceAuto: true });
    const b2b = await invoice(buyer.id, cgst);
    const consumer = await invoice(b2c.id, cgst);
    await drainJobs();
    const docs = await systemDb.many(`SELECT invoice_id, status FROM einvoice_documents WHERE invoice_id = ANY($1)`, [[b2b.id, consumer.id]]);
    expect(docs).toEqual([{ invoice_id: b2b.id, status: 'registered' }]);
    await as(t.owner.token).patch('/api/app/settings', { einvoiceAuto: false });
  });

  it('keeps e-invoices private to the business', async () => {
    const other = await registerTenant('Other EInv');
    const inv = await invoice(buyer.id, cgst);
    expect((await as(other.owner.token).get(`/api/app/einvoice/invoices/${inv.id}`)).status).toBe(404);
    expect((await as(other.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/irn`, {})).status).toBe(404);
  });

  it('computes the financial year used in the IRN', () => {
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-04-01')).toBe('2026-27');
  });
});

describe('EU e-invoicing (EN 16931 UBL: Peppol BIS 3.0 / XRechnung)', () => {
  let t: TenantCtx; let vat19: string; let buyer: any;
  beforeAll(async () => {
    t = await registerTenant('EInv DE', 'business', 'DE');
    await as(t.owner.token).patch('/api/app/settings/profile', { name: 'Kälte Service GmbH', legalName: 'Kälte Service GmbH', addressLine1: 'Hauptstraße 5', city: 'Berlin', postalCode: '10115', country: 'DE', phone: '+49 30 1234567', email: 'rechnung@kaelte.example' });
    await as(t.owner.token).patch('/api/app/settings', { taxRegistrationNumber: 'DE123456789', peppolId: '9930:DE123456789', bankAccountName: 'Kälte Service GmbH', bankIban: 'DE02 1203 0000 0000 2020 51', bankBic: 'BYLADEM1001' });
    vat19 = await taxRate(t.owner.token, (r) => Number(r.rate) === 19);
    buyer = (await as(t.owner.token).post('/api/app/customers', { customerType: 'business', fullName: 'Petra Klein', companyName: 'Stadtwerke Musterstadt', taxId: 'DE987654321',
      billingLine1: 'Am Markt 1', billingCity: 'Potsdam', billingPostalCode: '14467', billingCountry: 'DE', email: 'einkauf@stadtwerke.example',
      peppolId: '0204:991-01234-56', buyerReference: '991-01234-56' })).body.data;
  });

  const invoice = async () => (await as(t.owner.token).post('/api/app/invoices', { customerId: buyer.id, issue: true, items: [
    { itemType: 'labour', description: 'Wartung Klimaanlage', quantity: 1.5, unitPrice: 89.9, taxRateId: vat19 },
    { itemType: 'part', description: 'Filter & Kältemittel', quantity: 3, unitPrice: 33.33, discountPercent: 10, taxRateId: vat19 }] })).body.data;

  const sumTag = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<cbc:${tag} currencyID="EUR">([\\d.]+)<`, 'g'))].map((m) => Number(m[1]));
  const one = (xml: string, tag: string) => sumTag(xml, tag)[0];

  it('exports a consistent XRechnung invoice', async () => {
    const inv = await invoice();
    const r = await as(t.owner.token).get(`/api/app/einvoice/invoices/${inv.id}/ubl?variant=xrechnung`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/xml');
    const xml = r.text;
    save('xrechnung-invoice.xml', xml);
    expect(xml).toContain('urn:xeinkauf.de:kosit:xrechnung_3.0');
    expect(xml).toContain('<cbc:BuyerReference>991-01234-56</cbc:BuyerReference>');
    expect(xml).toContain('<cbc:EndpointID schemeID="0204">991-01234-56</cbc:EndpointID>');
    expect(xml).toContain('<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>');
    // EN 16931 arithmetic: BR-CO-10 (sum of lines), BR-CO-15 (incl = excl + VAT), payable = document total
    const lineSum = sumTag(xml, 'LineExtensionAmount').slice(1).reduce((a, b) => a + b, 0);
    expect(one(xml, 'LineExtensionAmount')).toBeCloseTo(lineSum, 2);
    expect(one(xml, 'TaxInclusiveAmount')).toBeCloseTo(one(xml, 'TaxExclusiveAmount') + one(xml, 'TaxAmount'), 2);
    const payable = one(xml, 'PayableAmount'); const rounding = one(xml, 'PayableRoundingAmount') ?? 0;
    expect(payable).toBeCloseTo(Number(inv.total), 2);
    expect(payable).toBeCloseTo(one(xml, 'TaxInclusiveAmount') + rounding, 2);
  });

  it('exports Peppol BIS credit notes referencing the invoice', async () => {
    const inv = await invoice();
    const cn = (await as(t.owner.token).post(`/api/app/invoices/${inv.id}/credit-notes`, { amount: 50, reason: 'Kulanz' })).body.data;
    const r = await as(t.owner.token).get(`/api/app/einvoice/invoices/${inv.id}/ubl?variant=peppol&creditNoteId=${cn.id}`);
    expect(r.status).toBe(200);
    save('peppol-creditnote.xml', r.text);
    expect(r.text).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(r.text).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(r.text).toContain(`<cbc:ID>${inv.number}</cbc:ID>`);
    expect(one(r.text, 'PayableAmount')).toBeCloseTo(50, 2);
    const x = await as(t.owner.token).get(`/api/app/einvoice/invoices/${inv.id}/ubl?variant=xrechnung&creditNoteId=${cn.id}`);
    save('xrechnung-creditnote.xml', x.text);
  });

  it('sends via the Peppol provider once and reports missing data', async () => {
    const inv = await invoice();
    expect((await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/peppol`, { variant: 'xrechnung' })).status).toBe(422); // no provider yet
    await as(t.owner.token).put('/api/app/integrations/peppol', { provider: 'peppol_test', mode: 'test', enabled: true });
    const sent = await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/peppol`, { variant: 'xrechnung' });
    expect(sent.status).toBe(201);
    expect(sent.body.data).toMatchObject({ scheme: 'XRECHNUNG', status: 'sent' });
    expect((await as(t.owner.token).post(`/api/app/einvoice/invoices/${inv.id}/peppol`, { variant: 'xrechnung' })).status).toBe(409);

    const noRef = (await as(t.owner.token).post('/api/app/customers', { customerType: 'business', fullName: 'Max', companyName: 'Privat GmbH', billingLine1: 'Weg 2', billingCity: 'Köln', billingPostalCode: '50667', billingCountry: 'DE' })).body.data;
    const i2 = (await as(t.owner.token).post('/api/app/invoices', { customerId: noRef.id, issue: true, items: [{ itemType: 'labour', description: 'Service', quantity: 1, unitPrice: 100, taxRateId: vat19 }] })).body.data;
    const d = await as(t.owner.token).get(`/api/app/einvoice/invoices/${i2.id}`);
    expect(d.body.data.schemes).toEqual(['PEPPOL_BIS3', 'XRECHNUNG']);
    expect(d.body.data.readiness.XRECHNUNG.map((i: any) => i.field)).toEqual(expect.arrayContaining(['buyer.reference', 'buyer.endpoint']));
    const bad = await as(t.owner.token).get(`/api/app/einvoice/invoices/${i2.id}/ubl?variant=xrechnung`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('EINVOICE_INVALID');
  });

  it('escapes XML special characters', async () => {
    const c = (await as(t.owner.token).post('/api/app/customers', { customerType: 'business', fullName: 'A & B <Test>', companyName: 'Müller & Söhne "GmbH"', taxId: 'DE111111111',
      billingLine1: 'Straße 1 <a>', billingCity: 'Bonn', billingPostalCode: '53111', billingCountry: 'DE', email: 'x@example.com' })).body.data;
    const i = (await as(t.owner.token).post('/api/app/invoices', { customerId: c.id, issue: true, items: [{ itemType: 'labour', description: 'Fix <script>&', quantity: 1, unitPrice: 10, taxRateId: vat19 }] })).body.data;
    const r = await as(t.owner.token).get(`/api/app/einvoice/invoices/${i.id}/ubl?variant=peppol`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('Müller &amp; Söhne &quot;GmbH&quot;');
    expect(r.text).toContain('Fix &lt;script&gt;&amp;');
    expect(r.text).not.toContain('<script>');
    save('peppol-invoice-escaping.xml', r.text);
  });
});
