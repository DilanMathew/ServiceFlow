import { describe, it, expect } from 'vitest';
import { registerTenant, as, drainJobs } from './helpers.js';
import { outbox } from '../src/integrations/email.js';
import { pdfT } from '../src/lib/pdfI18n.js';

describe('localisation', () => {
  it('sends customer messages in the business language and respects custom templates', async () => {
    const t = await registerTenant('Sprache', 'business', 'DE');
    const email = `kunde-${Date.now()}@example.com`;
    const c = (await as(t.owner.token).post('/api/app/customers', { fullName: 'Petra Klein', email, phone: '+49 30 555 0101' })).body.data;
    await as(t.owner.token).post('/api/app/requests', { customerId: c.id, description: 'Klimaanlage kühlt nicht mehr' });
    await drainJobs();
    const msg = [...outbox].reverse().find((m) => m.to === email);
    expect(msg?.subject).toContain('Wir haben Ihre Serviceanfrage');
    expect(msg?.text).toContain('Hallo Petra Klein');

    // a template customised by the business always wins over the translated default
    await as(t.owner.token).put('/api/app/notifications/templates', { event: 'request.created', channel: 'email', subject: 'Danke! {{request.number}}', body: 'Eigener Text {{customer.name}}', isActive: true });
    await as(t.owner.token).post('/api/app/requests', { customerId: c.id, description: 'Zweite Anfrage für Wartung' });
    await drainJobs();
    const custom = [...outbox].reverse().find((m) => m.to === email);
    expect(custom?.subject).toMatch(/^Danke! /);
    expect(custom?.text).toContain('Eigener Text Petra Klein');
  });

  it('keeps English for languages without translated defaults', async () => {
    const t = await registerTenant('English Biz', 'business', 'GB');
    const email = `cust-${Date.now()}@example.com`;
    const c = (await as(t.owner.token).post('/api/app/customers', { fullName: 'Sam Smith', email })).body.data;
    await as(t.owner.token).post('/api/app/requests', { customerId: c.id, description: 'Boiler service needed' });
    await drainJobs();
    expect([...outbox].reverse().find((m) => m.to === email)?.subject).toContain('We received your service request');
  });

  it('translates PDF labels for de/fr/es and falls back to English', () => {
    expect(pdfT('de-DE')('Tax Invoice')).toBe('Rechnung');
    expect(pdfT('fr-FR')('Balance due')).toBe('Reste à payer');
    expect(pdfT('es-ES')('Customer signature')).toBe('Firma del cliente');
    expect(pdfT('hi-IN')('Tax Invoice')).toBe('Tax Invoice');
    expect(pdfT('de-DE')('Something unknown')).toBe('Something unknown');
  });
});
