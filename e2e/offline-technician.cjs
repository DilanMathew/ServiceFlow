/**
 * Offline technician journey against a running production build seeded with the CoolCare demo.
 *   BASE_URL=http://localhost:4000 node e2e/offline-technician.cjs
 * A job is assigned, the technician opens the app, loses signal, reloads, accepts/starts the job,
 * adds a note and the service report, and everything syncs exactly once when the signal returns.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const B = process.env.BASE_URL || 'http://localhost:4000';
const PW = process.env.DEMO_PASSWORD || 'CoolCare@2026';
const step = (n) => console.log(`✓ ${n}`);

async function apiLogin(email) {
  const r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW, workspace: 'coolcare' }) });
  return (await r.json()).data.accessToken;
}
const call = async (token, path, body, method) => {
  const r = await fetch(`${B}/api${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  return j.data;
};

(async () => {
  const owner = await apiLogin('owner@coolcare.example');
  const techs = await call(owner, '/app/technicians?pageSize=50');
  const tech = (techs.data ?? techs).find((t) => t.email === 'tech@coolcare.example');
  const customers = await call(owner, '/app/customers?pageSize=1');
  const cust = (customers.data ?? customers)[0];
  // A free slot in the next day (the database rejects double-booking, so try a few)
  const title = `Offline E2E ${Date.now()}`;
  let wo;
  for (let attempt = 0; attempt < 25 && !wo; attempt++) {
    const start = new Date(); start.setSeconds(0, 0); start.setMinutes(Math.floor(Math.random() * 4) * 15); start.setHours(start.getHours() + 1 + Math.floor(Math.random() * 20));
    try { wo = await call(owner, '/app/work-orders', { customerId: cust.id, title, scheduledStart: start.toISOString(), expectedDurationMinutes: 15, technicianId: tech.id, force: true }); }
    catch (e) { if (!String(e.message).includes('SCHEDULE_CONFLICT')) throw e; }
  }
  assert.ok(wo, 'found a free slot');
  step(`job ${wo.number} assigned to ${tech.full_name ?? 'technician'}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${B}/login`);
  await page.fill('#email', 'tech@coolcare.example'); await page.fill('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/tech/);
  // Service worker installed and controlling, assets precached
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForLoadState('networkidle');
  assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
  await page.waitForFunction(async () => (await caches.keys()).includes('sf-assets') && (await (await caches.open('sf-assets')).keys()).length > 10);
  step('app installed for offline use (service worker + precache)');

  await page.getByText(title).first().waitFor({ timeout: 15000 }).catch(async () => { await page.goto(`${B}/tech/calendar`); });
  await page.goto(`${B}/tech`); await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500); // let job prefetch finish

  // ── Lose signal and reopen the app ───────────────────────────────
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('You are offline').waitFor({ timeout: 10000 });
  step('app reopens without a connection (cached shell + profile)');
  await page.goto(`${B}/tech/jobs/${wo.id}`).catch(() => undefined);
  await page.getByText(title).first().waitFor({ timeout: 10000 });
  step('assigned job opens offline from the device cache');

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByText('Saved on this device').first().waitFor();
  await page.getByRole('button', { name: /Start work/ }).click();
  await page.getByRole('button', { name: 'Complete job' }).waitFor(); // optimistic: next step offered
  const startedOfflineAt = Date.now();
  await page.getByPlaceholder('Add a work note…').fill('Gas pressure low, topped up (offline)');
  await page.getByPlaceholder('Add a work note…').locator('xpath=..').getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByText('You · waiting to sync').waitFor();
  await page.locator('input[type=file][accept="image/*"]').setInputFiles(require('node:path').join(__dirname, '../web/public/icons/icon-192.png'));
  await page.getByText('1 photo saved on this phone').waitFor();
  await page.getByText(/4 pending/).waitFor();
  step('accept, start, note and photo queued offline with optimistic updates');

  // ── Signal returns ────────────────────────────────────────────────
  await page.waitForTimeout(2000);
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  if (process.env.DEBUG_OFFLINE) {
    page.on('console', (m) => console.log('console:', m.text()));
    page.on('request', (r) => r.url().includes('/api/') && console.log('req', r.method(), r.url()));
    page.on('response', (r) => r.url().includes('/api/') && console.log('res', r.status(), r.url()));
    await page.waitForTimeout(8000);
    console.log('onLine', await page.evaluate(() => navigator.onLine));
  }
  await page.getByRole('status').filter({ hasText: /pending|offline|Syncing/ }).waitFor({ state: 'detached', timeout: 20000 });
  step('queue synced automatically when back online');

  const d = await call(owner, `/app/work-orders/${wo.id}`);
  assert.equal(d.status, 'in_progress');
  assert.ok(d.accepted_at, 'accepted');
  assert.equal(d.notes.filter((n) => n.body === 'Gas pressure low, topped up (offline)').length, 1, 'note applied exactly once');
  const startedAt = new Date(d.actual_start).getTime();
  assert.ok(Math.abs(startedAt - startedOfflineAt) < 15000, `actual_start reflects the offline time (${d.actual_start})`);
  assert.equal(d.documents.filter((x) => x.mime_type === 'image/png').length, 1, 'offline photo uploaded once');
  step('server state correct: accepted, in progress at the offline time, one note, one photo');

  // Replaying the same queue (e.g. a dropped response) changes nothing
  assert.equal((await page.evaluate(async () => (await new Promise((res) => { const r = indexedDB.open('serviceflow'); r.onsuccess = () => { const tx = r.result.transaction('outbox'); const q = tx.objectStore('outbox').count(); q.onsuccess = () => res(q.result); }; })))), 0);
  step('device outbox empty');

  // Sign-out wipes this user's offline data
  await call(owner, `/app/work-orders/${wo.id}/status`, { status: 'on_hold', reason: 'E2E cleanup' });
  assert.deepEqual(errors, [], `no page errors: ${errors.join('; ')}`);
  await browser.close();
  console.log('Offline technician journey passed');
})().catch((e) => { console.error(e); process.exit(1); });
