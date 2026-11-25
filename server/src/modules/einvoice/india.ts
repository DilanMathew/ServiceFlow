/**
 * India GST e-invoice (IRN) payload — NIC/IRP JSON schema version 1.1 — built from an issued
 * invoice's frozen snapshot, plus the validations the IRP applies, so problems are shown to the
 * user before anything is submitted.
 */
import crypto from 'node:crypto';

export const GST_STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06', delhi: '07',
  rajasthan: '08', 'uttar pradesh': '09', bihar: '10', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15',
  tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', orissa: '21', chhattisgarh: '22',
  'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26', 'daman and diu': '26', 'dadra and nagar haveli': '26',
  maharashtra: '27', karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32', 'tamil nadu': '33', puducherry: '34', pondicherry: '34',
  'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37', ladakh: '38', 'other territory': '97',
};

export const GSTIN_RE = /^(0[1-9]|[1-3][0-9]|9[67])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const DOC_NO_RE = /^[A-Z1-9][A-Z0-9/-]{0,15}$/;
const HSN_RE = /^(\d{4}|\d{6}|\d{8})$/;
// GST rates accepted by the IRP (including the 40% slab introduced in 2025).
const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown) => Number(v ?? 0);

export function stateCode(state?: string | null): string | null {
  if (!state) return null;
  const s = state.trim().toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ');
  if (/^\d{2}$/.test(s)) return s;
  return GST_STATE_CODES[s] ?? null;
}

export interface IrnInput {
  docType: 'INV' | 'CRN';
  number: string;
  date: string;                      // ISO date (yyyy-mm-dd)
  seller: any; buyer: any;           // invoice snapshots
  placeOfSupply?: string | null;
  items: { description: string; hsn_sac_code: string | null; quantity: number | string; line_subtotal: number | string; line_discount: number | string;
    line_tax: number | string; line_total: number | string; tax_rate: number | string; tax_components: { name: string; rate: number; amount: number }[]; item_type: string }[];
  /** For a credit note: the original invoice (number/date) it adjusts. */
  preceding?: { number: string; date: string };
}

export interface ValidationIssue { field: string; message: string }

const ddmmyyyy = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const clip = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function buildIrnPayload(inp: IrnInput): { payload: any; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const need = (ok: unknown, field: string, message: string) => { if (!ok) issues.push({ field, message }); };
  const seller = inp.seller ?? {}; const buyer = inp.buyer ?? {};
  const sp = seller.parts ?? {}; const bp = buyer.parts ?? {};
  const sGstin = String(seller.tax_id ?? '').toUpperCase().trim();
  const bGstin = String(buyer.tax_id ?? '').toUpperCase().trim();

  need(GSTIN_RE.test(sGstin), 'seller.gstin', 'Your business GSTIN is missing or invalid (Settings → Business → Tax registration).');
  need(bGstin, 'buyer.gstin', 'The customer has no GSTIN. E-invoices are only required for B2B supplies to GST-registered buyers.');
  if (bGstin) need(GSTIN_RE.test(bGstin) || bGstin === 'URP', 'buyer.gstin', `Customer GSTIN "${bGstin}" is not a valid GSTIN.`);
  need(bGstin !== sGstin, 'buyer.gstin', 'Buyer and seller GSTIN cannot be the same.');
  need(DOC_NO_RE.test(inp.number), 'doc.number', `Document number "${inp.number}" must be at most 16 characters (A–Z, 0–9, / and -) and not start with 0.`);

  const sStcd = sGstin.slice(0, 2) || stateCode(sp.state);
  const bStcd = (GSTIN_RE.test(bGstin) ? bGstin.slice(0, 2) : null) || stateCode(bp.state);
  const pos = stateCode(inp.placeOfSupply) ?? bStcd;
  need(sp.line1 && String(sp.line1).length >= 1, 'seller.address', 'Your business address (line 1) is required.');
  need(sp.city, 'seller.city', 'Your business city is required.');
  need(/^[1-9]\d{5}$/.test(String(sp.postal_code ?? '')), 'seller.pin', 'Your business PIN code must be 6 digits.');
  need(bp.line1, 'buyer.address', 'Customer billing address (line 1) is required.');
  need(bp.city, 'buyer.city', 'Customer billing city is required.');
  need(/^[1-9]\d{5}$/.test(String(bp.postal_code ?? '')), 'buyer.pin', 'Customer billing PIN code must be 6 digits.');
  need(bStcd, 'buyer.state', 'Customer state could not be determined (GSTIN or billing state).');
  need(pos, 'placeOfSupply', 'Place of supply could not be determined.');

  const interState = !!pos && !!sStcd && pos !== sStcd;
  const ItemList = inp.items.map((it, i) => {
    const qty = num(it.quantity); const tot = r2(num(it.line_subtotal)); const disc = r2(num(it.line_discount));
    const ass = r2(tot - disc);
    const comp = (n: string) => r2((it.tax_components ?? []).filter((c) => c.name.toUpperCase() === n).reduce((a, c) => a + num(c.amount), 0));
    let igst = comp('IGST'); let cgst = comp('CGST'); let sgst = comp('SGST') + comp('UTGST');
    const other = r2(num(it.line_tax) - igst - cgst - sgst);
    if (other) { if (interState) igst = r2(igst + other); else { cgst = r2(cgst + other / 2); sgst = r2(sgst + other / 2); } }
    const hsn = String(it.hsn_sac_code ?? '').replace(/\s/g, '');
    const rate = num(it.tax_rate);
    const isServc = hsn.startsWith('99') || it.item_type === 'labour' || it.item_type === 'amc' ? 'Y' : 'N';
    need(HSN_RE.test(hsn), `items[${i}].hsn`, `Line ${i + 1} ("${clip(it.description, 40)}") needs a valid HSN/SAC code (4, 6 or 8 digits).`);
    need(GST_RATES.includes(rate), `items[${i}].rate`, `Line ${i + 1} has GST rate ${rate}%, which the IRP does not accept.`);
    if (rate > 0) {
      if (interState) need(!cgst && !sgst, `items[${i}].tax`, `Line ${i + 1}: inter-state supply must be charged IGST, not CGST/SGST.`);
      else need(!igst, `items[${i}].tax`, `Line ${i + 1}: intra-state supply must be charged CGST + SGST, not IGST.`);
    }
    return {
      SlNo: String(i + 1), PrdDesc: clip(it.description, 300) || 'Service', IsServc: isServc, HsnCd: hsn,
      Qty: r3(qty), Unit: isServc === 'Y' ? 'OTH' : 'NOS', UnitPrice: r3(qty ? tot / qty : tot), TotAmt: tot, Discount: disc, AssAmt: ass, GstRt: rate,
      IgstAmt: igst, CgstAmt: cgst, SgstAmt: sgst, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0,
      TotItemVal: r2(ass + igst + cgst + sgst),
    };
  });
  need(ItemList.length > 0, 'items', 'The document has no lines.');

  const sum = (k: keyof (typeof ItemList)[number]) => r2(ItemList.reduce((a, x) => a + Number(x[k]), 0));
  const payload: any = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: inp.docType, No: inp.number, Dt: ddmmyyyy(inp.date) },
    SellerDtls: { Gstin: sGstin, LglNm: clip(seller.name, 100), TrdNm: clip(seller.trade_name ?? seller.name, 100), Addr1: clip(sp.line1, 100), Addr2: clip(sp.line2, 100) || undefined,
      Loc: clip(sp.city, 50), Pin: Number(sp.postal_code), Stcd: sStcd, Ph: clip(String(seller.phone ?? '').replace(/\D/g, '').slice(-12), 12) || undefined, Em: clip(seller.email, 100) || undefined },
    BuyerDtls: { Gstin: bGstin, LglNm: clip(buyer.name, 100), Pos: pos, Addr1: clip(bp.line1, 100), Addr2: clip(bp.line2, 100) || undefined, Loc: clip(bp.city, 50),
      Pin: Number(bp.postal_code), Stcd: bStcd, Ph: clip(String(buyer.phone ?? '').replace(/\D/g, '').slice(-12), 12) || undefined, Em: clip(buyer.email, 100) || undefined },
    ItemList,
    ValDtls: { AssVal: sum('AssAmt'), CgstVal: sum('CgstAmt'), SgstVal: sum('SgstAmt'), IgstVal: sum('IgstAmt'), CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: sum('TotItemVal') },
  };
  if (inp.preceding) payload.RefDtls = { PrecDocDtls: [{ InvNo: inp.preceding.number, InvDt: ddmmyyyy(inp.preceding.date) }] };
  return { payload: JSON.parse(JSON.stringify(payload)), issues };
}

/** Indian financial year of a date, e.g. 2026-11-25 → "2026-27". */
export function financialYear(isoDate: string) {
  const [y, m] = isoDate.slice(0, 7).split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** IRN as defined by the IRP: SHA-256 of GSTIN + financial year + document type + document number. */
export function computeIrn(gstin: string, isoDate: string, docType: string, docNo: string) {
  return crypto.createHash('sha256').update(`${gstin}${financialYear(isoDate)}${docType}${docNo}`).digest('hex');
}
