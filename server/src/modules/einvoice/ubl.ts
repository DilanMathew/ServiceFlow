/**
 * EN 16931 invoices and credit notes in UBL 2.1, as Peppol BIS Billing 3.0 or XRechnung 3.0 (CIUS-DE).
 * Amounts are taken from the issued invoice's lines; VAT category totals are recomputed the way the
 * EN 16931 business rules require (BR-CO-17), with any cent difference shown as a rounding amount.
 */
export type UblVariant = 'peppol' | 'xrechnung';

export const CUSTOMIZATION: Record<UblVariant, string> = {
  peppol: 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0',
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
};
const PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

export interface UblLine { description: string; quantity: number | string; line_subtotal: number | string; line_discount: number | string; line_tax: number | string; tax_rate: number | string; item_type?: string }
export interface UblInput {
  variant: UblVariant;
  kind: 'invoice' | 'credit_note';
  number: string; issueDate: string; dueDate?: string | null; currency: string;
  seller: any; buyer: any;
  lines: UblLine[];
  note?: string | null;
  /** Credit notes reference the invoice they correct (BT-25/26). */
  billingReference?: { number: string; date: string } | null;
  orderReference?: string | null;
  amountPaid?: number;
}
export interface ValidationIssue { field: string; message: string }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const a2 = (n: number) => r2(n).toFixed(2);
const num = (v: unknown) => Number(v ?? 0);
/** Net unit price with enough precision that quantity × price rounds back to the line amount (PEPPOL-EN16931-R120). */
const priceStr = (p: number) => { const s = p.toFixed(6).replace(/0+$/, ''); return s.endsWith('.') ? `${s}00` : s.split('.')[1]?.length === 1 ? `${s}0` : s; };
const EU_VAT_RE = /^[A-Z]{2}[0-9A-Z+*.]{2,13}$/;

function splitEndpoint(id?: string | null) {
  if (!id) return null;
  const i = id.indexOf(':');
  return i > 0 ? { scheme: id.slice(0, i), value: id.slice(i + 1) } : null;
}

export function buildUbl(inp: UblInput): { xml: string; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const need = (ok: unknown, field: string, message: string) => { if (!ok) issues.push({ field, message }); };
  const s = inp.seller ?? {}; const b = inp.buyer ?? {};
  const sp = s.parts ?? {}; const bp = b.parts ?? {};
  const sCountry = String(sp.country ?? s.country ?? '').toUpperCase();
  const bCountry = String(bp.country ?? '').toUpperCase();
  const sVat = String(s.tax_id ?? '').toUpperCase().replace(/\s/g, '');
  const bVat = String(b.tax_id ?? '').toUpperCase().replace(/\s/g, '');
  const sEndpoint = splitEndpoint(s.peppol_id) ?? (s.email ? { scheme: 'EM', value: s.email } : null);
  const bEndpoint = splitEndpoint(b.peppol_id) ?? (b.email ? { scheme: 'EM', value: b.email } : null);

  need(/^[A-Z]{2}$/.test(sCountry), 'seller.country', 'Your business country is required.');
  need(/^[A-Z]{2}$/.test(bCountry), 'buyer.country', 'The customer billing country is required.');
  need(sVat && EU_VAT_RE.test(sVat), 'seller.vat', 'Your VAT identification number is missing or not in EU format (e.g. DE123456789) — Settings → Business.');
  need(s.name, 'seller.name', 'Your legal business name is required.');
  need(b.name, 'buyer.name', 'The customer name is required.');
  need(sp.city && sp.postal_code, 'seller.address', 'Your business city and postcode are required.');
  need(bp.city && bp.postal_code, 'buyer.address', 'Customer billing city and postcode are required.');
  need(sEndpoint, 'seller.endpoint', 'Add your Peppol ID (Settings → E-invoicing) or a business email.');
  need(bEndpoint, 'buyer.endpoint', 'Add the customer’s Peppol ID or email address.');
  if (inp.variant === 'xrechnung') {
    need(b.buyer_reference, 'buyer.reference', 'XRechnung requires the buyer reference (Leitweg-ID) on the customer.');
    need(s.phone && s.email, 'seller.contact', 'XRechnung requires your business phone and email (seller contact).');
    need(s.bank?.iban, 'seller.iban', 'XRechnung requires payment details: add your IBAN in Settings → E-invoicing.');
  }
  need(inp.lines.length, 'lines', 'The document has no lines.');

  // Lines: net amount = subtotal − discount (all amounts exclusive of VAT, as stored).
  const lines = inp.lines.map((l, i) => {
    const qty = num(l.quantity); const net = r2(num(l.line_subtotal) - num(l.line_discount)); const rate = num(l.tax_rate);
    return { id: i + 1, name: String(l.description).slice(0, 200) || 'Service', qty, net, rate, cat: rate > 0 ? 'S' : 'Z', price: qty ? net / qty : net, lineTax: num(l.line_tax) };
  });
  // VAT breakdown per (category, rate) — BR-CO-17: tax = taxable × rate, rounded per category.
  const groups = new Map<string, { cat: string; rate: number; taxable: number; tax: number }>();
  for (const l of lines) {
    const k = `${l.cat}:${l.rate}`;
    const g = groups.get(k) ?? { cat: l.cat, rate: l.rate, taxable: 0, tax: 0 };
    g.taxable = r2(g.taxable + l.net); groups.set(k, g);
  }
  for (const g of groups.values()) g.tax = r2((g.taxable * g.rate) / 100);
  const lineExt = r2(lines.reduce((a, l) => a + l.net, 0));
  const taxTotal = r2([...groups.values()].reduce((a, g) => a + g.tax, 0));
  const taxInclusive = r2(lineExt + taxTotal);
  // Our invoice total uses per-line rounding; keep the payable equal to the issued document.
  const documentTotal = r2(lines.reduce((a, l) => a + l.net + l.lineTax, 0));
  const rounding = r2(documentTotal - taxInclusive);
  const prepaid = r2(inp.amountPaid ?? 0);
  const payable = r2(taxInclusive + rounding - prepaid);

  const isCn = inp.kind === 'credit_note';
  const root = isCn ? 'CreditNote' : 'Invoice';
  const ns = isCn ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  const cur = esc(inp.currency);
  const amt = (tag: string, v: number) => `<cbc:${tag} currencyID="${cur}">${a2(v)}</cbc:${tag}>`;
  const party = (p: any, parts: any, country: string, vat: string, endpoint: { scheme: string; value: string } | null, contact: boolean) => `
      <cac:Party>
        ${endpoint ? `<cbc:EndpointID schemeID="${esc(endpoint.scheme)}">${esc(endpoint.value)}</cbc:EndpointID>` : ''}
        ${p.trade_name && p.trade_name !== p.name ? `<cac:PartyName><cbc:Name>${esc(p.trade_name)}</cbc:Name></cac:PartyName>` : ''}
        <cac:PostalAddress>
          ${parts.line1 ? `<cbc:StreetName>${esc(parts.line1)}</cbc:StreetName>` : ''}
          ${parts.line2 ? `<cbc:AdditionalStreetName>${esc(parts.line2)}</cbc:AdditionalStreetName>` : ''}
          ${parts.city ? `<cbc:CityName>${esc(parts.city)}</cbc:CityName>` : ''}
          ${parts.postal_code ? `<cbc:PostalZone>${esc(parts.postal_code)}</cbc:PostalZone>` : ''}
          ${parts.state ? `<cbc:CountrySubentity>${esc(parts.state)}</cbc:CountrySubentity>` : ''}
          <cac:Country><cbc:IdentificationCode>${esc(country)}</cbc:IdentificationCode></cac:Country>
        </cac:PostalAddress>
        ${vat && EU_VAT_RE.test(vat) ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(vat)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ''}
        <cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName></cac:PartyLegalEntity>
        ${contact && (p.phone || p.email) ? `<cac:Contact><cbc:Name>${esc(p.contact ?? p.name)}</cbc:Name>${p.phone ? `<cbc:Telephone>${esc(p.phone)}</cbc:Telephone>` : ''}${p.email ? `<cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail>` : ''}</cac:Contact>` : ''}
      </cac:Party>`;

  const qtyTag = isCn ? 'CreditedQuantity' : 'InvoicedQuantity';
  const lineTag = isCn ? 'CreditNoteLine' : 'InvoiceLine';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${CUSTOMIZATION[inp.variant]}</cbc:CustomizationID>
  <cbc:ProfileID>${PROFILE}</cbc:ProfileID>
  <cbc:ID>${esc(inp.number)}</cbc:ID>
  <cbc:IssueDate>${esc(inp.issueDate.slice(0, 10))}</cbc:IssueDate>
  ${!isCn && inp.dueDate ? `<cbc:DueDate>${esc(inp.dueDate.slice(0, 10))}</cbc:DueDate>` : ''}
  <cbc:${isCn ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${isCn ? '381' : '380'}</cbc:${isCn ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>
  ${inp.note ? `<cbc:Note>${esc(inp.note).slice(0, 1000)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${b.buyer_reference ? `<cbc:BuyerReference>${esc(b.buyer_reference)}</cbc:BuyerReference>` : `<cbc:BuyerReference>${esc(inp.number)}</cbc:BuyerReference>`}
  ${inp.orderReference ? `<cac:OrderReference><cbc:ID>${esc(inp.orderReference)}</cbc:ID></cac:OrderReference>` : ''}
  ${inp.billingReference ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${esc(inp.billingReference.number)}</cbc:ID><cbc:IssueDate>${esc(inp.billingReference.date.slice(0, 10))}</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
  <cac:AccountingSupplierParty>${party(s, sp, sCountry, sVat, sEndpoint, true)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>${party(b, bp, bCountry, bVat, bEndpoint, false)}
  </cac:AccountingCustomerParty>
  ${s.bank?.iban ? `<cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>${esc(inp.number)}</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>${esc(String(s.bank.iban).replace(/\s/g, ''))}</cbc:ID>${s.bank.name ? `<cbc:Name>${esc(s.bank.name)}</cbc:Name>` : ''}${s.bank.bic ? `<cac:FinancialInstitutionBranch><cbc:ID>${esc(s.bank.bic)}</cbc:ID></cac:FinancialInstitutionBranch>` : ''}</cac:PayeeFinancialAccount></cac:PaymentMeans>`
    : `<cac:PaymentMeans><cbc:PaymentMeansCode>1</cbc:PaymentMeansCode></cac:PaymentMeans>`}
  ${!isCn && inp.dueDate ? `<cac:PaymentTerms><cbc:Note>Payment due by ${esc(inp.dueDate.slice(0, 10))}</cbc:Note></cac:PaymentTerms>` : ''}
  <cac:TaxTotal>
    ${amt('TaxAmount', taxTotal)}
    ${[...groups.values()].map((g) => `<cac:TaxSubtotal>${amt('TaxableAmount', g.taxable)}${amt('TaxAmount', g.tax)}<cac:TaxCategory><cbc:ID>${g.cat}</cbc:ID><cbc:Percent>${g.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join('\n    ')}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    ${amt('LineExtensionAmount', lineExt)}
    ${amt('TaxExclusiveAmount', lineExt)}
    ${amt('TaxInclusiveAmount', taxInclusive)}
    ${prepaid ? amt('PrepaidAmount', prepaid) : ''}
    ${rounding ? amt('PayableRoundingAmount', rounding) : ''}
    ${amt('PayableAmount', payable)}
  </cac:LegalMonetaryTotal>
  ${lines.map((l) => `<cac:${lineTag}>
    <cbc:ID>${l.id}</cbc:ID>
    <cbc:${qtyTag} unitCode="C62">${l.qty}</cbc:${qtyTag}>
    ${amt('LineExtensionAmount', l.net)}
    <cac:Item><cbc:Name>${esc(l.name)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${l.cat}</cbc:ID><cbc:Percent>${l.rate}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${cur}">${priceStr(l.price)}</cbc:PriceAmount></cac:Price>
  </cac:${lineTag}>`).join('\n  ')}
</${root}>`;
  // Collapse blank lines left by optional elements.
  return { xml: xml.replace(/\n\s*\n/g, '\n'), issues };
}
