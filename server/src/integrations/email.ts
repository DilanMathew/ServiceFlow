import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { TenantIntegration } from './registry.js';

export interface EmailMessage { to: string; subject: string; text: string; html?: string; fromName?: string; replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[] }
export interface SendResult { provider: string; messageId: string | null }

/** Messages captured by the console driver (used by tests and local development). */
export const outbox: EmailMessage[] = [];

let platformTransport: nodemailer.Transporter | null = null;
function platform() {
  if (!platformTransport && config.EMAIL_DRIVER === 'smtp') {
    platformTransport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined });
  }
  return platformTransport;
}

export async function sendEmail(msg: EmailMessage, integration?: TenantIntegration | null): Promise<SendResult> {
  if (integration?.provider === 'smtp' && integration.mode === 'live') {
    const t = nodemailer.createTransport({ host: integration.config.host, port: Number(integration.config.port ?? 587),
      secure: Number(integration.config.port) === 465, auth: { user: integration.config.user, pass: integration.secrets.password } });
    const r = await t.sendMail({ from: `"${integration.config.fromName ?? msg.fromName ?? ''}" <${integration.config.fromAddress}>`, to: msg.to,
      subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments });
    return { provider: 'smtp', messageId: r.messageId };
  }
  const t = platform();
  if (!t) {
    outbox.push(msg);
    if (outbox.length > 200) outbox.shift();
    logger.info({ to: msg.to, subject: msg.subject }, '[email:console] message captured (EMAIL_DRIVER=console)');
    if (config.NODE_ENV === 'development') console.log(`\n--- EMAIL to ${msg.to}: ${msg.subject}\n${msg.text}\n---\n`);
    return { provider: 'console', messageId: `console-${Date.now()}` };
  }
  const fromAddr = config.EMAIL_FROM.match(/<(.+)>/)?.[1] ?? config.EMAIL_FROM;
  const r = await t.sendMail({ from: msg.fromName ? `"${msg.fromName.replace(/"/g, '')} via NEXUS" <${fromAddr}>` : config.EMAIL_FROM,
    replyTo: msg.replyTo, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments });
  return { provider: 'smtp', messageId: r.messageId };
}

export function simpleHtml(title: string, body: string, brand = 'NEXUS ServiceFlow') {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const linked = esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2563eb">$1</a>').replace(/\n/g, '<br>');
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;color:#0f172a">
    <div style="font-weight:700;color:#0b1f44;font-size:18px;margin-bottom:16px">${esc(brand)}</div>
    <h2 style="font-size:18px;margin:0 0 12px">${esc(title)}</h2><p style="line-height:1.6;font-size:14px">${linked}</p>
    <p style="color:#64748b;font-size:12px;margin-top:32px">Sent via NEXUS ServiceFlow</p></div>`;
}
