/**
 * End-to-end critical journeys against a running instance seeded with the CoolCare demo.
 *   BASE_URL=http://localhost:4000 node e2e/critical-journeys.cjs
 * Uses the Playwright that ships with the environment (require('playwright')).
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const B = process.env.BASE_URL || 'http://localhost:4000';
const PW = process.env.DEMO_PASSWORD || 'CoolCare@2026';

async function login(browser, email, { mobile = false, portal = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(B + (portal ? '/portal/coolcare/login' : '/login'));
  await page.fill('#email', email); await page.fill('#password', PW);
  await page.click('button[type=submit]');
  await page.waitForLoadState('networkidle');
  return { ctx, page, errors };
}
const step = (n) => console.log(`✓ ${n}`);

(async () => {
  const browser = await chromium.launch();
  const title = `E2E job ${Date.now()}`;
  // 1. Dispatcher creates a job and assigns a technician
  const d = await login(browser, 'dispatch@coolcare.example');
  await d.page.goto(`${B}/app/work-orders/new`);
  await d.page.getByPlaceholder('Search customer by name, phone or number…').fill('a');
  await d.page.locator('div.absolute button').first().click();
  await d.page.getByPlaceholder('e.g. AC not cooling — bedroom').fill(title);
  // A unique future slot each run (the DB rejects double-booking the same technician)
  const start = new Date(Date.now() + (3 + Math.floor(Math.random() * 600)) * 864e5); start.setHours(5 + Math.floor(Math.random() * 6), 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  await d.page.locator('input[type=datetime-local]').fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:00`);
  await d.page.getByRole('button', { name: 'Create job' }).click();
  await d.page.waitForURL(/work-orders\/[0-9a-f-]{36}/);
  const jobUrl = d.page.url();
  step('dispatcher created job');
  await d.page.getByRole('button', { name: /^Assign$/ }).first().click();
  await d.page.getByText('Ravi Kumar').first().click();
  await d.page.getByRole('dialog').getByRole('button', { name: /^Assign$/ }).click();
  const warn = d.page.getByRole('button', { name: 'Assign anyway' });
  await warn.waitFor({ timeout: 5000 }).then(() => warn.click()).catch(() => undefined); // working-hours warnings need explicit confirmation
  await d.page.getByText('Assigned', { exact: true }).first().waitFor();
  step('dispatcher assigned Ravi Kumar');
  await d.ctx.close();

  // 2. Technician runs the job on a phone
  const t = await login(browser, 'tech@coolcare.example', { mobile: true });
  await t.page.goto(jobUrl.replace('/app/work-orders/', '/tech/jobs/'));
  await t.page.getByRole('button', { name: 'Accept job' }).click();
  await t.page.getByRole('button', { name: 'On my way' }).click();
  await t.page.getByRole('button', { name: 'Start work' }).click();
  await t.page.getByText('In Progress').first().waitFor();
  step('technician accepted, en route, started');
  await t.page.getByLabel('Work performed').fill('Cleaned filters and coil, checked gas pressure, cooling restored.');
  await t.page.getByRole('button', { name: 'Save report' }).click();
  await t.page.getByText('Report saved').waitFor();
  await t.page.getByRole('button', { name: 'Complete job' }).first().click();
  await t.page.getByRole('dialog').getByRole('button', { name: 'Complete job' }).click();
  await t.page.getByText('Completed').first().waitFor();
  step('technician completed job with service report');
  assert.deepEqual(t.errors, []);
  await t.ctx.close();

  // 3. Accountant invoices and records payment; job becomes paid only after payment
  const a = await login(browser, 'accounts@coolcare.example');
  await a.page.goto(jobUrl);
  await a.page.getByRole('button', { name: 'Create invoice' }).click();
  await a.page.waitForURL(/invoices\/[0-9a-f-]{36}/);
  await a.page.getByRole('button', { name: /^Edit$/ }).click();
  await a.page.getByLabel('Unit price').first().fill('1200');
  await a.page.getByRole('button', { name: 'Save & issue' }).click();
  await a.page.getByText('Issued').first().waitFor();
  step('accountant issued invoice');
  await a.page.goto(jobUrl); await a.page.getByText('Invoiced').first().waitFor();
  await a.page.goBack(); await a.page.waitForLoadState('networkidle');
  await a.page.getByRole('button', { name: 'Record payment' }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Record payment' }).click();
  await a.page.getByText('Payment recorded').waitFor();
  await a.page.getByText('Paid', { exact: true }).first().waitFor();
  await a.page.goto(jobUrl); await a.page.getByText('Paid', { exact: true }).first().waitFor();
  step('payment recorded → invoice paid → job paid');
  await a.ctx.close();

  // 4. Customer raises a request from the portal
  const c = await login(browser, 'customer@coolcare.example', { mobile: true, portal: true });
  await c.page.goto(`${B}/portal/requests/new`);
  await c.page.getByPlaceholder('Describe the problem').fill('E2E: AC in the bedroom is leaking water since yesterday.');
  await c.page.getByRole('button', { name: 'Send request' }).click();
  await c.page.waitForURL(/portal\/requests$/);
  await c.page.getByText('E2E: AC in the bedroom').first().waitFor();
  step('customer submitted service request via portal');
  await c.ctx.close();

  await browser.close();
  console.log('All critical journeys passed');
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
