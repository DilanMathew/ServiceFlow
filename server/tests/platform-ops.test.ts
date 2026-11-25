import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';
import { storage } from '../src/integrations/storage.js';

describe('operations endpoints', () => {
  it('readiness reports database, storage and queue', async () => {
    const r = await api().get('/api/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks).toMatchObject({ database: 'ok', storage: 'ok', queue: 'ok' });
  });

  it('storage health is a real round trip', async () => {
    await expect(storage.health()).resolves.toBe(true);
  });

  it('client-config exposes only public values', async () => {
    const r = await api().get('/api/public/client-config');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(['environment', 'release', 'sentryDsn', 'sentryTracesSampleRate', 'vapidPublicKey']);
    expect(r.body.data.sentryDsn).toBeNull();
    expect(r.body.data.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|password|private/i);
  });
});
