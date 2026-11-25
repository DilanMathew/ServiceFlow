import PDFDocument from 'pdfkit';
import { pdfT, type PdfT } from './pdfI18n.js';

const NAVY = '#0b1f44';
const BLUE = '#2563eb';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

/** PDF-safe money (core PDF fonts have no ₹/€ glyph coverage guarantees, so use ISO codes). */
export function pdfMoney(v: number | string | null | undefined, currency: string, locale = 'en-IN') {
  const n = Number(v ?? 0);
  return `${currency} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
}

export interface Party { name: string; lines: (string | null | undefined)[] }
export interface PdfLine { description: string; qty: number | string; unitPrice: number | string; discount?: number | string; taxRate?: number | string; total: number | string }
export interface FinancialDoc {
  title: string; number: string; status?: string; currency: string; locale?: string;
  seller: Party & { taxLabel?: string; taxId?: string | null };
  buyer: Party;
  meta: [string, string][];
  lines: PdfLine[];
  totals: [string, string, boolean?][];
  taxBreakdown?: { name: string; rate: number; amount: number }[];
  notes?: string | null; terms?: string | null; footer?: string | null;
  /** India GST e-invoice details printed on the invoice (IRN, acknowledgement and signed QR code). */
  einvoice?: { irn: string; ackNo: string; ackDate: string; qrPng: Buffer; test?: boolean } | null;
}

function finish(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, title: string, number: string, seller: FinancialDoc['seller'], status?: string, L: PdfT = (s) => s) {
  doc.rect(0, 0, doc.page.width, 6).fill(BLUE);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text(seller.name, 50, 36, { width: 300 });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  for (const l of seller.lines.filter(Boolean)) doc.text(String(l), { width: 300 });
  if (seller.taxId) doc.text(`${seller.taxLabel ?? L('Tax ID')}: ${seller.taxId}`);
  doc.font('Helvetica-Bold').fontSize(20).fillColor(NAVY).text(title.toUpperCase(), 330, 36, { width: 215, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(number, 330, doc.y + 2, { width: 215, align: 'right' });
  if (status) doc.fontSize(8).fillColor(BLUE).text(status.toUpperCase().replace('_', ' '), 330, doc.y + 2, { width: 215, align: 'right' });
  doc.moveDown(2);
}

export async function renderFinancialPdf(d: FinancialDoc): Promise<Buffer> {
  const L = pdfT(d.locale);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${d.title} ${d.number}`, Producer: 'NEXUS ServiceFlow' } });
  header(doc, d.title, d.number, d.seller, d.status, L);
  const top = Math.max(doc.y, 130);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(L('Bill to').toUpperCase(), 50, top);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#0f172a').text(d.buyer.name, 50, top + 12, { width: 260 });
  doc.font('Helvetica').fontSize(9).fillColor('#334155');
  for (const l of d.buyer.lines.filter(Boolean)) doc.text(String(l), { width: 260 });
  let my = top;
  for (const [k, v] of d.meta) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, 340, my, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#0f172a').text(v, 430, my, { width: 115, align: 'right' });
    my += 14;
  }
  let y = Math.max(doc.y, my) + 20;
  const cols = [50, 290, 335, 410, 455, 545];
  const heads = ['Description', 'Qty', 'Unit price', 'Tax', 'Amount'].map(L);
  doc.rect(50, y, 495, 20).fill('#f1f5f9');
  doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
  heads.forEach((h, i) => doc.text(h, cols[i] + 4, y + 6, { width: cols[i + 1] - cols[i] - 8, align: i === 0 ? 'left' : 'right' }));
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
  for (const l of d.lines) {
    const h = Math.max(doc.heightOfString(l.description, { width: 232 }), 12);
    if (y + h > 740) { doc.addPage(); y = 50; }
    doc.text(l.description + (Number(l.discount) > 0 ? ` (−${Number(l.discount)}%)` : ''), cols[0] + 4, y, { width: 232 });
    doc.text(String(Number(l.qty)), cols[1] + 4, y, { width: 37, align: 'right' });
    doc.text(pdfMoney(l.unitPrice, '', d.locale).trim(), cols[2] + 4, y, { width: 67, align: 'right' });
    doc.text(`${Number(l.taxRate ?? 0)}%`, cols[3] + 4, y, { width: 37, align: 'right' });
    doc.text(pdfMoney(l.total, '', d.locale).trim(), cols[4] + 4, y, { width: 82, align: 'right' });
    y += h + 8;
    doc.moveTo(50, y - 4).lineTo(545, y - 4).strokeColor(LINE).lineWidth(0.5).stroke();
  }
  y += 6;
  if (y > 650) { doc.addPage(); y = 50; }
  const totalsY = y;
  for (const [k, v, bold] of d.totals) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(bold ? NAVY : '#334155');
    doc.text(k, 330, y, { width: 110 }); doc.text(v, 440, y, { width: 105, align: 'right' });
    y += bold ? 18 : 14;
  }
  if (d.taxBreakdown?.length) {
    let ty = totalsY;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(L('Tax summary').toUpperCase(), 50, ty); ty += 12;
    doc.font('Helvetica').fontSize(8.5).fillColor('#334155');
    for (const t of d.taxBreakdown) { doc.text(`${t.name} @ ${t.rate}%`, 50, ty, { width: 140 }); doc.text(pdfMoney(t.amount, d.currency, d.locale), 190, ty, { width: 100, align: 'right' }); ty += 12; }
  }
  y += 16;
  if (d.einvoice) {
    if (y > 640) { doc.addPage(); y = 50; }
    doc.roundedRect(50, y, 495, 104, 6).lineWidth(0.7).strokeColor('#cbd5e1').stroke();
    doc.image(d.einvoice.qrPng, 58, y + 8, { width: 88, height: 88 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(d.einvoice.test ? 'E-INVOICE (SANDBOX — NOT REGISTERED WITH IRP)' : 'E-INVOICE (GST)', 156, y + 12);
    doc.font('Helvetica').fontSize(8).fillColor('#334155');
    doc.text(`IRN: ${d.einvoice.irn}`, 156, y + 26, { width: 380 });
    doc.text(`Ack No: ${d.einvoice.ackNo}    Ack Date: ${d.einvoice.ackDate}`, 156, doc.y + 4, { width: 380 });
    y += 116;
  }
  for (const [label, text] of [[L('Notes'), d.notes], [L('Terms & conditions'), d.terms]] as const) {
    if (!text) continue;
    if (y > 700) { doc.addPage(); y = 50; }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), 50, y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#334155').text(text, 50, y + 11, { width: 495 });
    y = doc.y + 12;
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(d.footer ?? L('Generated by NEXUS ServiceFlow'), 50, 790, { width: 495, align: 'center' });
  return finish(doc);
}

export interface SheetSection { heading: string; rows?: [string, string][]; text?: string | null; table?: { head: string[]; rows: string[][] } }
export async function renderSheetPdf(d: { title: string; number: string; seller: FinancialDoc['seller']; status?: string; sections: SheetSection[];
  signature?: Buffer | null; signedBy?: string | null; signedAt?: string | null; signatures?: boolean; locale?: string | null }): Promise<Buffer> {
  const L = pdfT(d.locale);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${d.title} ${d.number}`, Producer: 'NEXUS ServiceFlow' } });
  header(doc, d.title, d.number, d.seller, d.status, L);
  doc.y = Math.max(doc.y, 130);
  for (const s of d.sections) {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BLUE).text(s.heading.toUpperCase(), 50);
    doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.moveDown(0.4);
    for (const [k, v] of s.rows ?? []) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(k, 50, y, { width: 130 });
      doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(v || '—', 185, y, { width: 360 });
      doc.y = Math.max(doc.y, y + 12) + 2;
    }
    if (s.text) doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(s.text, 50, doc.y, { width: 495 });
    if (s.table) {
      const w = 495 / s.table.head.length;
      let y = doc.y + 2;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY);
      s.table.head.forEach((h, i) => doc.text(h, 50 + i * w, y, { width: w - 6 }));
      y += 14; doc.font('Helvetica').fontSize(8.5).fillColor('#0f172a');
      for (const r of s.table.rows) { r.forEach((c, i) => doc.text(c, 50 + i * w, y, { width: w - 6 })); y += 14; if (y > 760) { doc.addPage(); y = 50; } }
      doc.y = y;
    }
  }
  if (d.signatures === false) {
    doc.fontSize(7.5).fillColor(MUTED).text(L('Generated by NEXUS ServiceFlow'), 50, 790, { width: 495, align: 'center' });
    return finish(doc);
  }
  doc.moveDown(2);
  if (doc.y > 680) doc.addPage();
  const sy = doc.y;
  if (d.signature) { try { doc.image(d.signature, 50, sy, { fit: [180, 60] }); } catch { /* invalid image */ } }
  doc.moveTo(50, sy + 66).lineTo(250, sy + 66).strokeColor('#94a3b8').stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${L('Customer signature')}${d.signedBy ? ` — ${d.signedBy}` : ''}${d.signedAt ? ` (${d.signedAt})` : ''}`, 50, sy + 70);
  doc.moveTo(345, sy + 66).lineTo(545, sy + 66).stroke();
  doc.text(L('Technician signature'), 345, sy + 70);
  doc.fontSize(7.5).text(L('Generated by NEXUS ServiceFlow'), 50, 790, { width: 495, align: 'center' });
  return finish(doc);
}
