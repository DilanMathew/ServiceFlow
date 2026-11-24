import { config } from '../config.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import type { TenantIntegration } from './registry.js';

/**
 * Payment gateway abstraction for a TENANT collecting money from ITS OWN customers.
 * (NEXUS subscription billing is separate: modules/subscriptions.)
 * Card data never touches our servers: customers pay on the provider's hosted page.
 * A payment is recorded only from a signature-verified webhook, never from a browser redirect.
 */
export interface CheckoutInput { intentId: string; amount: number; currency: string; description: string; customerEmail?: string | null; returnUrl: string }
export interface WebhookEvent {
  eventId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed' | 'ignored';
  intentId?: string | null; providerOrderId?: string | null; providerPaymentId?: string | null;
  amount?: number; currency?: string; failureReason?: string | null; providerRefundId?: string | null;
}
export interface PaymentProvider {
  name: string;
  createCheckout(i: CheckoutInput): Promise<{ providerOrderId: string; checkoutUrl: string }>;
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): boolean;
  parseWebhook(raw: Buffer, headers: Record<string, string | undefined>): WebhookEvent;
  refund(p: { providerPaymentId: string; amount: number; currency: string; idempotencyKey: string }): Promise<{ providerRefundId: string; status: 'succeeded' | 'pending' | 'failed' }>;
}

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XOF', 'XAF', 'UGX']);
export const toMinor = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency) ? Math.round(amount) : Math.round(amount * 100));
export const fromMinor = (amount: number, currency: string) => (ZERO_DECIMAL.has(currency) ? amount : amount / 100);

/** Sandbox gateway: hosted checkout page inside the app; completion is delivered as a signed webhook. */
export const testGatewaySecret = () => hmacSha256Hex(config.JWT_SECRET, 'test-gateway-webhook');
class TestProvider implements PaymentProvider {
  name = 'test';
  async createCheckout(i: CheckoutInput) {
    return { providerOrderId: `test_order_${i.intentId}`, checkoutUrl: `${config.APP_URL}/pay/test/${i.intentId}` };
  }
  verifyWebhook(raw: Buffer, h: Record<string, string | undefined>) {
    const sig = h['x-test-signature'];
    return !!sig && safeEqual(sig, hmacSha256Hex(testGatewaySecret(), raw));
  }
  parseWebhook(raw: Buffer): WebhookEvent {
    const e = JSON.parse(raw.toString('utf8'));
    return { eventId: e.id, type: e.type, intentId: e.intentId, providerOrderId: e.orderId, providerPaymentId: e.paymentId,
      amount: e.amount, currency: e.currency, failureReason: e.failureReason, providerRefundId: e.refundId };
  }
  async refund(p: { providerPaymentId: string }) { return { providerRefundId: `test_rfnd_${p.providerPaymentId}_${Date.now()}`, status: 'succeeded' as const }; }
}

class RazorpayProvider implements PaymentProvider {
  name = 'razorpay';
  constructor(private i: TenantIntegration) {}
  private auth() { return 'Basic ' + Buffer.from(`${this.i.config.keyId}:${this.i.secrets.keySecret}`).toString('base64'); }
  async createCheckout(c: CheckoutInput) {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST', headers: { Authorization: this.auth(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ amount: toMinor(c.amount, c.currency), currency: c.currency, description: c.description.slice(0, 2048),
        reference_id: c.intentId.slice(0, 40), callback_url: c.returnUrl, callback_method: 'get', notes: { intent_id: c.intentId },
        customer: c.customerEmail ? { email: c.customerEmail } : undefined }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Razorpay: ${j?.error?.description ?? res.status}`);
    return { providerOrderId: j.id, checkoutUrl: j.short_url };
  }
  verifyWebhook(raw: Buffer, h: Record<string, string | undefined>) {
    const sig = h['x-razorpay-signature'];
    return !!sig && !!this.i.secrets.webhookSecret && safeEqual(sig, hmacSha256Hex(this.i.secrets.webhookSecret, raw));
  }
  parseWebhook(raw: Buffer, h: Record<string, string | undefined>): WebhookEvent {
    const e = JSON.parse(raw.toString('utf8'));
    const pay = e.payload?.payment?.entity;
    const link = e.payload?.payment_link?.entity;
    const refund = e.payload?.refund?.entity;
    const eventId = h['x-razorpay-event-id'] ?? `${e.event}:${pay?.id ?? refund?.id}`;
    const intentId = link?.notes?.intent_id ?? pay?.notes?.intent_id ?? null;
    if (e.event === 'payment_link.paid') return { eventId, type: 'payment.succeeded', intentId, providerOrderId: link?.id, providerPaymentId: pay?.id,
      amount: fromMinor(pay?.amount ?? 0, pay?.currency ?? 'INR'), currency: pay?.currency };
    if (e.event === 'payment.failed') return { eventId, type: 'payment.failed', intentId, providerPaymentId: pay?.id, failureReason: pay?.error_description ?? 'Payment failed' };
    if (e.event === 'refund.processed') return { eventId, type: 'refund.succeeded', providerRefundId: refund?.id, providerPaymentId: refund?.payment_id };
    if (e.event === 'refund.failed') return { eventId, type: 'refund.failed', providerRefundId: refund?.id, providerPaymentId: refund?.payment_id };
    return { eventId, type: 'ignored' };
  }
  async refund(p: { providerPaymentId: string; amount: number; currency: string; idempotencyKey: string }) {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(p.providerPaymentId)}/refund`, {
      method: 'POST', headers: { Authorization: this.auth(), 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ amount: toMinor(p.amount, p.currency), receipt: p.idempotencyKey.slice(0, 40) }),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Razorpay refund: ${j?.error?.description ?? res.status}`);
    return { providerRefundId: j.id, status: j.status === 'processed' ? 'succeeded' as const : 'pending' as const };
  }
}

class StripeProvider implements PaymentProvider {
  name = 'stripe';
  constructor(private i: TenantIntegration) {}
  private async post(path: string, form: Record<string, string>, idem: string) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${this.i.secrets.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem },
      body: new URLSearchParams(form),
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(`Stripe: ${j?.error?.message ?? res.status}`);
    return j;
  }
  async createCheckout(c: CheckoutInput) {
    const j = await this.post('checkout/sessions', {
      mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': c.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(toMinor(c.amount, c.currency)), 'line_items[0][price_data][product_data][name]': c.description.slice(0, 250),
      success_url: c.returnUrl, cancel_url: c.returnUrl, client_reference_id: c.intentId, 'metadata[intent_id]': c.intentId,
      'payment_intent_data[metadata][intent_id]': c.intentId, ...(c.customerEmail ? { customer_email: c.customerEmail } : {}),
    }, `checkout-${c.intentId}`);
    return { providerOrderId: j.id, checkoutUrl: j.url };
  }
  verifyWebhook(raw: Buffer, h: Record<string, string | undefined>) {
    const header = h['stripe-signature']; const secret = this.i.secrets.webhookSecret;
    if (!header || !secret) return false;
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
    const t = Number(parts.t);
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
    const expected = hmacSha256Hex(secret, `${t}.${raw.toString('utf8')}`);
    return header.split(',').filter((p) => p.startsWith('v1=')).some((p) => safeEqual(p.slice(3), expected));
  }
  parseWebhook(raw: Buffer): WebhookEvent {
    const e = JSON.parse(raw.toString('utf8')); const o = e.data?.object ?? {};
    if (e.type === 'checkout.session.completed' && o.payment_status === 'paid')
      return { eventId: e.id, type: 'payment.succeeded', intentId: o.metadata?.intent_id, providerOrderId: o.id, providerPaymentId: o.payment_intent,
        amount: fromMinor(o.amount_total, String(o.currency).toUpperCase()), currency: String(o.currency).toUpperCase() };
    if (e.type === 'payment_intent.payment_failed')
      return { eventId: e.id, type: 'payment.failed', intentId: o.metadata?.intent_id, providerPaymentId: o.id, failureReason: o.last_payment_error?.message ?? 'Payment failed' };
    if (e.type === 'refund.updated' || e.type === 'refund.created')
      return { eventId: e.id, type: o.status === 'succeeded' ? 'refund.succeeded' : o.status === 'failed' ? 'refund.failed' : 'ignored', providerRefundId: o.id, providerPaymentId: o.payment_intent };
    return { eventId: e.id, type: 'ignored' };
  }
  async refund(p: { providerPaymentId: string; amount: number; currency: string; idempotencyKey: string }) {
    const j = await this.post('refunds', { payment_intent: p.providerPaymentId, amount: String(toMinor(p.amount, p.currency)) }, `refund-${p.idempotencyKey}`);
    return { providerRefundId: j.id, status: j.status === 'succeeded' ? 'succeeded' as const : j.status === 'failed' ? 'failed' as const : 'pending' as const };
  }
}

export function paymentProvider(i: TenantIntegration | null): PaymentProvider | null {
  if (!i) return null;
  if (i.provider === 'test') return new TestProvider();
  if (i.provider === 'razorpay') return new RazorpayProvider(i);
  if (i.provider === 'stripe') return new StripeProvider(i);
  return null;
}
export const testProvider = new TestProvider();
