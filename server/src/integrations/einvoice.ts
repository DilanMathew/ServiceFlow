/**
 * E-invoicing transport providers.
 *
 * India (kind "einvoice"):
 *   - in_sandbox: no external call. Generates the IRN with the IRP algorithm and a clearly marked
 *     TEST signed-QR payload, so the whole flow (PDF, cancellation) works for trials and demos.
 *   - gsp: a GST Suvidha Provider's JSON API. GSPs expose the NIC e-invoice API (authentication,
 *     encryption, signing) behind simpler REST endpoints whose paths and auth differ per GSP, so the
 *     base URL, paths and headers are configuration. Verify with your GSP's sandbox before going live.
 *
 * EU (kind "peppol"):
 *   - peppol_test: records the UBL as transmitted without sending it anywhere.
 *   - peppol_http: POSTs the UBL document to your Peppol Access Point provider's REST API.
 */
import crypto from 'node:crypto';
import type { TenantIntegration } from './registry.js';
import { computeIrn } from '../modules/einvoice/india.js';

export interface IrnResult { irn: string; ackNo: string; ackDate: Date; signedInvoice: string | null; signedQr: string; raw?: unknown }

const b64url = (s: string) => Buffer.from(s).toString('base64url');

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 20_000) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`Provider returned ${res.status}: ${(json?.message ?? json?.error?.message ?? json?.ErrorDetails?.[0]?.ErrorMessage ?? text).toString().slice(0, 300)}`);
  return json;
}

/** Accepts the common response shapes GSPs use around the NIC fields. */
function pickIrn(j: any): IrnResult {
  const d = j?.data?.data ?? j?.data ?? j?.result ?? j?.Data ?? j;
  const irn = d?.Irn ?? d?.irn; const ackNo = d?.AckNo ?? d?.ackNo; const ackDt = d?.AckDt ?? d?.ackDt;
  if (!irn || !ackNo) {
    const err = j?.ErrorDetails?.[0]?.ErrorMessage ?? j?.error?.message ?? j?.message ?? 'No IRN in provider response';
    throw new Error(String(err).slice(0, 300));
  }
  return { irn, ackNo: String(ackNo), ackDate: ackDt ? new Date(String(ackDt).replace(' ', 'T') + (String(ackDt).includes('+') ? '' : '+05:30')) : new Date(),
    signedInvoice: d?.SignedInvoice ?? d?.signedInvoice ?? null, signedQr: d?.SignedQRCode ?? d?.signedQRCode ?? d?.SignedQrCode ?? '', raw: j };
}

function gspHeaders(integ: TenantIntegration) {
  const c = integ.config; const s = integ.secrets;
  const h: Record<string, string> = {};
  if (s.apiKey) h[c.apiKeyHeader || 'Authorization'] = c.apiKeyHeader ? s.apiKey : `Bearer ${s.apiKey}`;
  if (c.clientId) h.client_id = c.clientId;
  if (s.clientSecret) h.client_secret = s.clientSecret;
  if (c.username) h.user_name = c.username;
  if (s.password) h.password = s.password;
  if (c.gstin) h.gstin = c.gstin;
  return h;
}

export async function registerIrn(integ: TenantIntegration, payload: any, docDateIso: string): Promise<IrnResult> {
  if (integ.provider === 'in_sandbox') {
    const irn = computeIrn(payload.SellerDtls.Gstin, docDateIso, payload.DocDtls.Typ, payload.DocDtls.No);
    const ackNo = `1${String(BigInt('0x' + crypto.createHash('sha256').update(irn).digest('hex').slice(0, 13)) % 10n ** 14n).padStart(14, '0')}`;
    const ackDate = new Date();
    // Same claims as a real signed QR, but unsigned and marked TEST — never valid for compliance.
    const qrClaims = { data: JSON.stringify({ SellerGstin: payload.SellerDtls.Gstin, BuyerGstin: payload.BuyerDtls.Gstin, DocNo: payload.DocDtls.No, DocTyp: payload.DocDtls.Typ,
      DocDt: payload.DocDtls.Dt, TotInvVal: payload.ValDtls.TotInvVal, ItemCnt: payload.ItemList.length, MainHsnCode: payload.ItemList[0]?.HsnCd, Irn: irn, IrnDt: ackDate.toISOString() }), iss: 'NEXUS ServiceFlow SANDBOX (not registered with IRP)' };
    const signedQr = `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT', test: true }))}.${b64url(JSON.stringify(qrClaims))}.`;
    return { irn, ackNo, ackDate, signedInvoice: null, signedQr };
  }
  if (integ.provider === 'gsp') {
    if (!integ.config.baseUrl) throw new Error('GSP base URL is not configured');
    const url = new URL(integ.config.generatePath || '/einvoice/generate', integ.config.baseUrl).toString();
    return pickIrn(await postJson(url, payload, gspHeaders(integ)));
  }
  throw new Error(`Unknown e-invoice provider ${integ.provider}`);
}

/** Cancel an IRN (allowed by the IRP within 24 hours). Reason codes: 1 duplicate, 2 data entry mistake, 3 order cancelled, 4 other. */
export async function cancelIrn(integ: TenantIntegration, irn: string, reasonCode: '1' | '2' | '3' | '4', remark: string) {
  if (integ.provider === 'in_sandbox') return { cancelledAt: new Date() };
  if (integ.provider === 'gsp') {
    const url = new URL(integ.config.cancelPath || '/einvoice/cancel', integ.config.baseUrl).toString();
    const j = await postJson(url, { Irn: irn, CnlRsn: reasonCode, CnlRem: remark.slice(0, 100) }, gspHeaders(integ));
    const d = j?.data ?? j?.result ?? j;
    return { cancelledAt: d?.CancelDate ? new Date(String(d.CancelDate).replace(' ', 'T') + '+05:30') : new Date() };
  }
  throw new Error(`Unknown e-invoice provider ${integ.provider}`);
}

export async function transmitPeppol(integ: TenantIntegration, xml: string, meta: { documentNumber: string; receiver: string | null; sender: string | null }) {
  if (integ.provider === 'peppol_test') return { providerRef: `test-${crypto.randomUUID()}` };
  if (integ.provider === 'peppol_http') {
    if (!integ.config.endpointUrl) throw new Error('Access Point endpoint URL is not configured');
    const res = await fetch(integ.config.endpointUrl, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/xml', accept: 'application/json', ...(integ.secrets.apiKey ? { authorization: `Bearer ${integ.secrets.apiKey}` } : {}),
        ...(meta.receiver ? { 'x-peppol-receiver': meta.receiver } : {}), ...(meta.sender ? { 'x-peppol-sender': meta.sender } : {}) },
      body: xml,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Access Point returned ${res.status}: ${text.slice(0, 300)}`);
    let ref: string | null = null; try { const j = JSON.parse(text); ref = j.id ?? j.guid ?? j.transmissionId ?? j.data?.id ?? null; } catch { /* plain text */ }
    return { providerRef: ref ?? res.headers.get('location') ?? `accepted-${Date.now()}` };
  }
  throw new Error(`Unknown Peppol provider ${integ.provider}`);
}
