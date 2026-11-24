import { systemDb, withSystem, withTenant, type Db } from '../db/pool.js';
import { hashPassword } from '../lib/crypto.js';
import { nextNumber } from '../lib/numbering.js';
import { calcLine, calcTotals } from '../lib/money.js';
import { logger } from '../logger.js';
import { provisionTenant, assignRole, applyCategoryPreset } from '../modules/tenants/provision.js';
import { bootstrapReferenceData } from '../auth/bootstrap.js';
import { moveStock } from '../modules/inventory/service.js';
import { recomputeInvoice } from '../modules/invoices/service.js';
import { generateVisits } from '../modules/amc/routes.js';

/**
 * Demo tenant "CoolCare Services" (Bengaluru AC service company). Flagged is_demo = true so it is
 * excluded from platform revenue figures and can be removed safely. All dashboard numbers are
 * derived from these records at query time — nothing is hard-coded.
 */
export const DEMO_SLUG = 'coolcare';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'CoolCare@2026';

// Deterministic PRNG so the demo is identical on every install
let seed = 20260101;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Navya',
  'Meera', 'Kavya', 'Priya', 'Rahul', 'Suresh', 'Lakshmi', 'Deepa', 'Nikhil', 'Pooja', 'Kiran', 'Manoj', 'Shreya', 'Varun', 'Neha', 'Harish', 'Divya', 'Ramesh', 'Sneha'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Nair', 'Rao', 'Gowda', 'Patel', 'Menon', 'Kumar', 'Shetty', 'Pillai', 'Hegde', 'Joshi', 'Kulkarni', 'Bhat', 'Das', 'Singh', 'Agarwal'];
const AREAS = [
  { name: 'Koramangala', pins: ['560034', '560095'], lat: 12.9352, lng: 77.6245 }, { name: 'Indiranagar', pins: ['560038'], lat: 12.9719, lng: 77.6412 },
  { name: 'Whitefield', pins: ['560066', '560048'], lat: 12.9698, lng: 77.7500 }, { name: 'Jayanagar', pins: ['560011', '560041'], lat: 12.9250, lng: 77.5938 },
  { name: 'HSR Layout', pins: ['560102'], lat: 12.9121, lng: 77.6446 }, { name: 'Malleshwaram', pins: ['560003'], lat: 13.0035, lng: 77.5709 },
  { name: 'Electronic City', pins: ['560100'], lat: 12.8452, lng: 77.6602 }, { name: 'Hebbal', pins: ['560024'], lat: 13.0358, lng: 77.5970 },
];
const STREETS = ['80 Feet Road', '100 Feet Road', 'CMH Road', '5th Cross', '12th Main', 'Outer Ring Road', 'Sarjapur Road', 'Bannerghatta Road', '17th Cross', 'Service Road'];
const AC_BRANDS = [['Daikin', 'FTKF50'], ['Voltas', '183V CZT'], ['LG', 'RS-Q19YNZE'], ['Blue Star', 'IC318DNU'], ['Samsung', 'AR18BYEAMWK'], ['Carrier', 'Estrella 18K'], ['Hitachi', 'RSOG518HCEA'], ['Panasonic', 'CS-SU18ZKYW']];
const PROBLEMS = ['AC not cooling properly, blowing warm air', 'Water leaking from indoor unit onto the wall', 'Loud rattling noise from outdoor unit', 'AC trips the MCB after 10 minutes',
  'Remote not working and display blinking', 'Bad smell when AC is switched on', 'Ice forming on the indoor coil', 'Annual servicing due before summer', 'New split AC installation in bedroom',
  'Gas refill required, cooling very low'];

export async function seedDemo(opts: { skipIfExists?: boolean; reset?: boolean } = {}) {
  const existing = await systemDb.maybeOne(`SELECT id FROM tenants WHERE slug = $1`, [DEMO_SLUG]);
  if (existing && opts.skipIfExists && !opts.reset) { logger.info('demo tenant already exists; skipping'); return existing.id as string; }
  if (existing) throw new Error('Demo tenant exists. Remove it first (npm run seed -- --reset requires a fresh database).');
  await withSystem(bootstrapReferenceData);
  seed = 20260101;
  const pw = await hashPassword(DEMO_PASSWORD);

  // ---------------------------------------------------------------- tenant, users, roles
  const { tenantId, branchId, userIds } = await withSystem(async (db) => {
    const { tenant, branchId } = await provisionTenant(db, { businessName: 'CoolCare Services', slug: DEMO_SLUG, country: 'IN', email: 'hello@coolcare.example',
      phone: '+91 80 4567 8900', planCode: 'business', isDemo: true });
    await db.query(`UPDATE tenants SET legal_name = 'CoolCare Services Pvt Ltd', address_line1 = '42, 2nd Floor, 80 Feet Road, Koramangala 4th Block', city = 'Bengaluru',
      state = 'Karnataka', postal_code = '560034', business_category = 'hvac', employee_count = 22, technician_count = 10 WHERE id = $1`, [tenant.id]);
    // Demo stays on an active Business subscription so every module is visible
    await db.query(`UPDATE subscriptions SET status = 'active', current_period_end = now() + interval '1 year', trial_ends_at = now() WHERE tenant_id = $1`, [tenant.id]);
    const mk = async (email: string, name: string, role: string, phone: string) => {
      const u = await db.one(`INSERT INTO users (tenant_id, branch_id, email, password_hash, full_name, phone, user_type, email_verified_at, last_login_at)
        VALUES ($1,$2,$3,$4,$5,$6,'staff', now(), now() - interval '2 hours') RETURNING id`, [tenant.id, branchId, email, pw, name, phone]);
      await assignRole(db, u.id, tenant.id, role);
      return u.id as string;
    };
    const userIds = {
      owner: await mk('owner@coolcare.example', 'Rajesh Menon', 'owner', '+91 98450 11111'),
      admin1: await mk('admin@coolcare.example', 'Lakshmi Iyer', 'admin', '+91 98450 22222'),
      admin2: await mk('ops@coolcare.example', 'Farhan Sheikh', 'admin', '+91 98450 33333'),
      dispatcher: await mk('dispatch@coolcare.example', 'Kavya Rao', 'dispatcher', '+91 98450 44444'),
      accountant: await mk('accounts@coolcare.example', 'Suresh Kulkarni', 'accountant', '+91 98450 55555'),
      techs: [] as string[],
    };
    const techNames = ['Ravi Kumar', 'Manjunath Gowda', 'Imran Pasha', 'Venkatesh R', 'Arun Prakash', 'Shivakumar B', 'Naveen Shetty', 'Prakash Naik', 'Syed Ahmed', 'Dinesh Bhat'];
    for (let i = 0; i < techNames.length; i++) userIds.techs.push(await mk(i === 0 ? 'tech@coolcare.example' : `tech${i + 1}@coolcare.example`, techNames[i], 'technician', `+91 99000 ${String(10000 + i * 1111).slice(0, 5)}`));
    return { tenantId: tenant.id as string, branchId: branchId as string, userIds };
  });
  await applyCategoryPreset(tenantId, 'hvac');

  await withTenant(tenantId, async (db) => {
    await db.query(`UPDATE tenant_settings SET tax_registration_number = '29ABCDE1234F1Z5', onboarding_step = 5, onboarding_completed_at = now(),
      invoice_footer = 'Thank you for choosing CoolCare. Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0001234. UPI: coolcare@hdfcbank',
      quotation_terms = '50% advance for installations. Prices valid for 30 days. 90-day workmanship warranty on repairs.',
      cancellation_policy = 'Free cancellation up to 24 hours before the visit. Later cancellations may incur a visit charge of ₹299.',
      prevent_double_booking = true, inventory_enabled = true WHERE tenant_id = $1`, [tenantId]);
    await db.query(`UPDATE service_categories SET default_price = CASE name WHEN 'AC Installation' THEN 1999 WHEN 'AC Repair' THEN 599 WHEN 'AC Servicing' THEN 499 WHEN 'Gas Refilling' THEN 2499 ELSE 499 END`);
    const areaIds: string[] = [];
    for (const a of AREAS) areaIds.push((await db.one(`INSERT INTO service_areas (tenant_id, branch_id, name, postal_codes) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, branchId, a.name, a.pins])).id);
    for (const [d, n] of [['2026-01-26', 'Republic Day'], ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-11-01', 'Kannada Rajyotsava'], ['2026-12-25', 'Christmas']])
      await db.query(`INSERT INTO holidays (tenant_id, date, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, d, n]);
    const cats = await db.many(`SELECT id, name, default_duration_minutes FROM service_categories ORDER BY name`);
    const acCat = (await db.one(`SELECT id FROM equipment_categories WHERE name = 'Split AC'`)).id;

    // ---------------------------------------------------------------- technicians
    const techIds: string[] = [];
    for (let i = 0; i < userIds.techs.length; i++) {
      const area = AREAS[i % AREAS.length];
      const tp = await db.one(`INSERT INTO technician_profiles (tenant_id, user_id, branch_id, employee_id, employment_type, hourly_cost, max_jobs_per_day, home_latitude, home_longitude)
        VALUES ($1,$2,$3,$4,$5,$6,6,$7,$8) RETURNING id`, [tenantId, userIds.techs[i], branchId, `CC-T${String(101 + i)}`, i < 8 ? 'full_time' : 'contractor', 250 + i * 15,
          area.lat + (rnd() - 0.5) * 0.02, area.lng + (rnd() - 0.5) * 0.02]);
      techIds.push(tp.id);
      for (const c of cats) if (rnd() > 0.25 || c.name === 'AC Repair') await db.query(`INSERT INTO technician_skills (tenant_id, technician_id, service_category_id, proficiency) VALUES ($1,$2,$3,$4)`, [tenantId, tp.id, c.id, int(2, 5)]);
      for (const k of [i % 8, (i + 3) % 8, (i + 5) % 8]) await db.query(`INSERT INTO technician_service_areas (tenant_id, technician_id, service_area_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, tp.id, areaIds[k]]);
      for (let d = 1; d <= 6; d++) await db.query(`INSERT INTO technician_availability (tenant_id, technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'09:00','19:00')`, [tenantId, tp.id, d]);
    }
    await db.query(`INSERT INTO technician_time_off (tenant_id, technician_id, starts_at, ends_at, reason) VALUES ($1,$2, date_trunc('day', now()) + interval '3 days', date_trunc('day', now()) + interval '5 days', 'Family function')`, [tenantId, techIds[9]]);

    // ---------------------------------------------------------------- inventory
    const sup = (await db.one(`INSERT INTO suppliers (tenant_id, name, contact_name, phone, email) VALUES ($1,'Karnataka HVAC Distributors','Anil Jain','+91 80 2222 3333','orders@khvac.example') RETURNING id`, [tenantId])).id;
    const sup2 = (await db.one(`INSERT INTO suppliers (tenant_id, name, contact_name, phone) VALUES ($1,'Cool Parts India','Meena Das','+91 80 4444 5555') RETURNING id`, [tenantId])).id;
    const gst18 = (await db.one(`SELECT id FROM tax_rates WHERE name LIKE 'GST 18%%' LIMIT 1`)).id;
    const loc = (await db.one(`SELECT id FROM stock_locations WHERE is_default LIMIT 1`)).id;
    const items: { id: string; name: string; price: number; cost: number }[] = [];
    const catalogue: [string, string, string, number, number, number, number, string][] = [
      ['GAS-R32-1KG', 'R32 Refrigerant Gas (1 kg)', 'Refrigerant', 650, 1200, 40, 10, 'kg'], ['GAS-R410A-1KG', 'R410A Refrigerant Gas (1 kg)', 'Refrigerant', 720, 1350, 25, 8, 'kg'],
      ['CAP-35MFD', 'Run Capacitor 35+5 MFD', 'Electrical', 180, 450, 30, 10, 'pcs'], ['CAP-45MFD', 'Run Capacitor 45+5 MFD', 'Electrical', 210, 520, 6, 10, 'pcs'],
      ['FAN-MTR-IDU', 'Indoor Fan Motor (universal)', 'Motors', 1400, 2600, 8, 3, 'pcs'], ['FAN-MTR-ODU', 'Outdoor Fan Motor', 'Motors', 1900, 3400, 5, 2, 'pcs'],
      ['PCB-UNIV', 'Universal AC PCB Kit', 'Electronics', 1100, 2200, 2, 3, 'pcs'], ['DRAIN-PIPE-3M', 'Drain Pipe (3 m)', 'Installation', 60, 180, 80, 20, 'pcs'],
      ['CU-PIPE-1/4', 'Copper Pipe 1/4" (per m)', 'Installation', 180, 350, 120, 30, 'm'], ['CU-PIPE-1/2', 'Copper Pipe 1/2" (per m)', 'Installation', 320, 580, 90, 30, 'm'],
      ['STAND-ODU', 'Outdoor Unit Wall Stand', 'Installation', 450, 950, 22, 8, 'pcs'], ['INS-TAPE', 'Insulation Tape Roll', 'Consumables', 40, 90, 150, 40, 'pcs'],
      ['FILTER-SET', 'Air Filter Set', 'Consumables', 220, 480, 35, 10, 'set'], ['COIL-CLEAN', 'Coil Cleaning Chemical (1 L)', 'Consumables', 280, 0, 18, 6, 'L'],
      ['REMOTE-UNIV', 'Universal AC Remote', 'Accessories', 250, 550, 4, 5, 'pcs'], ['THERMISTOR', 'Room Temperature Thermistor', 'Electronics', 120, 350, 15, 5, 'pcs'],
    ];
    for (const [sku, name, cat, cost, price, qty, min, unit] of catalogue) {
      const it = await db.one(`INSERT INTO inventory_items (tenant_id, sku, name, category, purchase_price, selling_price, tax_rate_id, min_stock, supplier_id, unit)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [tenantId, sku, name, cat, cost, price, gst18, min, cat === 'Motors' || cat === 'Electronics' ? sup2 : sup, unit]);
      await moveStock(db, { itemId: it.id, locationId: loc, quantityChange: qty, type: 'opening', unitCost: cost, reason: 'Opening stock', userId: userIds.owner });
      items.push({ id: it.id, name, price, cost });
    }
    const pr = await db.one(`INSERT INTO purchase_records (tenant_id, supplier_id, location_id, reference, purchase_date, total_amount, created_by) VALUES ($1,$2,$3,'KHD/2026/0412', current_date - 20, 13000, $4) RETURNING id`, [tenantId, sup, loc, userIds.owner]);
    await db.query(`INSERT INTO purchase_record_items (tenant_id, purchase_record_id, item_id, quantity, unit_cost) VALUES ($1,$2,$3,20,650)`, [tenantId, pr.id, items[0].id]);
    await moveStock(db, { itemId: items[0].id, locationId: loc, quantityChange: 20, type: 'purchase', unitCost: 650, referenceType: 'purchase', referenceId: pr.id, reason: 'Purchase KHD/2026/0412', userId: userIds.owner });

    // ---------------------------------------------------------------- customers (100) + addresses
    const customers: { id: string; addressId: string; area: typeof AREAS[number]; name: string }[] = [];
    for (let i = 0; i < 100; i++) {
      const biz = i % 9 === 0;
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const area = AREAS[i % AREAS.length];
      const phone = `+91 9${String(800000000 + i * 7919).slice(0, 9)}`;
      const createdDaysAgo = Math.floor((i / 100) * 360) + int(0, 3);
      const c = await db.one(`INSERT INTO customers (tenant_id, branch_id, number, customer_type, full_name, company_name, email, phone, phone_normalized, billing_city, billing_state, billing_postal_code, billing_country, source, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Bengaluru','Karnataka',$10,'IN',$11,$12, now() - ($13 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'customer'), biz ? 'business' : 'individual', name, biz ? `${pick(['Sunrise', 'Greenleaf', 'Lotus', 'Silverline', 'Bluebell'])} ${pick(['Cafe', 'Clinic', 'Offices', 'Apartments', 'Boutique'])}` : null,
          `${name.toLowerCase().replace(/[^a-z]/g, '.')}${i}@example.com`, phone, phone.replace(/\D/g, '').slice(-10), area.pins[0], pick(['referral', 'google', 'walk_in', 'justdial', 'repeat', 'portal']),
          userIds.admin1, String(360 - createdDaysAgo)]);
      const a = await db.one(`INSERT INTO customer_addresses (tenant_id, customer_id, label, line1, line2, city, state, postal_code, country, latitude, longitude, service_area_id, is_default)
        VALUES ($1,$2,$3,$4,$5,'Bengaluru','Karnataka',$6,'IN',$7,$8,$9,true) RETURNING id`,
        [tenantId, c.id, biz ? 'Office' : 'Home', `#${int(1, 999)}, ${pick(STREETS)}`, `${area.name}`, pick(area.pins), area.lat + (rnd() - 0.5) * 0.03, area.lng + (rnd() - 0.5) * 0.03, areaIds[i % AREAS.length]]);
      customers.push({ id: c.id, addressId: a.id, area, name });
    }
    // Portal login for the first customer
    const portalUser = await db.one(`INSERT INTO users (tenant_id, email, password_hash, full_name, phone, user_type, email_verified_at) VALUES ($1,'customer@coolcare.example',$2,$3,'+91 98000 00000','customer', now()) RETURNING id`,
      [tenantId, pw, customers[0].name]);
    const custRole = (await db.one(`SELECT id FROM roles WHERE key = 'customer' AND tenant_id IS NULL`)).id;
    await db.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1,$2,$3)`, [portalUser.id, custRole, tenantId]);
    await db.query(`UPDATE customers SET portal_user_id = $2, email = 'customer@coolcare.example' WHERE id = $1`, [customers[0].id, portalUser.id]);

    // ---------------------------------------------------------------- 50 AC assets
    const assets: { id: string; customerIdx: number }[] = [];
    for (let i = 0; i < 50; i++) {
      const ci = i < 10 ? i : int(0, 99);
      const [brand, model] = pick(AC_BRANDS);
      const installedDaysAgo = int(60, 1500);
      const install = new Date(Date.now() - installedDaysAgo * 86400000).toISOString().slice(0, 10);
      const wexp = new Date(Date.now() - installedDaysAgo * 86400000 + 365 * (rnd() > 0.5 ? 5 : 1) * 86400000).toISOString().slice(0, 10);
      const a = await db.one(`INSERT INTO assets (tenant_id, number, customer_id, address_id, equipment_category_id, name, manufacturer, model, serial_number, capacity, installation_date, purchase_date,
          warranty_start, warranty_expiry, next_service_due) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11,$12, current_date + $13::int) RETURNING id`,
        [tenantId, await nextNumber(db, 'asset'), customers[ci].id, customers[ci].addressId, acCat, `${pick(['Bedroom', 'Living room', 'Master bedroom', 'Office cabin', 'Reception', 'Kids room'])} AC`,
          brand, model, `${brand.slice(0, 2).toUpperCase()}${int(100000, 999999)}${String.fromCharCode(65 + int(0, 25))}`, pick(['1 Ton', '1.5 Ton', '2 Ton']), install, wexp, int(-20, 120)]);
      assets.push({ id: a.id, customerIdx: ci });
    }

    // ---------------------------------------------------------------- 30 work orders across the lifecycle
    type Plan = { status: string; dayOffset: number; hour: number; invoice?: 'paid' | 'unpaid' | 'overdue' | 'partial'; cancelled?: string; hold?: string };
    const plans: Plan[] = [
      ...[-85, -72, -64, -51, -43, -36].map((d, i) => ({ status: 'completed', dayOffset: d, hour: 10 + (i % 4) * 2, invoice: 'paid' as const })),
      { status: 'completed', dayOffset: -28, hour: 11, invoice: 'overdue' }, { status: 'completed', dayOffset: -12, hour: 15, invoice: 'partial' },
      { status: 'completed', dayOffset: -3, hour: 10 }, { status: 'completed', dayOffset: -1, hour: 16 },
      { status: 'cancelled', dayOffset: -40, hour: 12, cancelled: 'Customer travelling, will call back' }, { status: 'cancelled', dayOffset: -18, hour: 14, cancelled: 'Duplicate booking' },
      { status: 'rejected', dayOffset: -9, hour: 10, cancelled: 'Outside service area (Mysuru)' },
      { status: 'in_progress', dayOffset: 0, hour: -2 }, { status: 'in_progress', dayOffset: 0, hour: -1 },
      { status: 'en_route', dayOffset: 0, hour: 1 }, { status: 'assigned', dayOffset: 0, hour: 3 },
      ...[1, 1, 2, 3, 5, 6].map((d, i) => ({ status: 'assigned', dayOffset: d, hour: 10 + (i % 3) * 3 })),
      { status: 'scheduled', dayOffset: 2, hour: 11 }, { status: 'scheduled', dayOffset: 4, hour: 14 }, { status: 'scheduled', dayOffset: 7, hour: 10 },
      { status: 'new', dayOffset: 0, hour: 0 }, { status: 'approved', dayOffset: 0, hour: 0 },
      { status: 'on_hold', dayOffset: -2, hour: 12, hold: 'Waiting for PCB part from supplier' }, { status: 'on_hold', dayOffset: -1, hour: 15, hold: 'Customer not available, call back' },
    ];
    const tz = 'Asia/Kolkata';
    const at = (dayOffset: number, hour: number) => {
      const d = new Date(); d.setUTCHours(0, 0, 0, 0);
      if (hour < 0 || (dayOffset === 0 && hour > 0)) return new Date(Math.round((Date.now() + hour * 3600000) / 900000) * 900000); // relative to now
      return new Date(d.getTime() + dayOffset * 86400000 + (hour - 5.5) * 3600000); // IST wall-clock hour
    };
    let techCursor = 0;
    const jobs: any[] = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const asset = assets[i % assets.length];
      const cust = customers[asset.customerIdx];
      const problem = PROBLEMS[i % PROBLEMS.length];
      const cat = /install/i.test(problem) ? cats.find((c) => c.name === 'AC Installation')! : /servic/i.test(problem) ? cats.find((c) => c.name === 'AC Servicing')!
        : /gas/i.test(problem) ? cats.find((c) => c.name === 'Gas Refilling')! : cats.find((c) => c.name === 'AC Repair')!;
      const start = p.status === 'new' || p.status === 'approved' ? null : at(p.dayOffset, p.hour);
      const tech = ['scheduled', 'new', 'approved', 'cancelled', 'rejected'].includes(p.status) ? null : techIds[techCursor++ % techIds.length];
      const duration = cat.default_duration_minutes;
      const created = new Date((start?.getTime() ?? Date.now()) - int(1, 4) * 86400000);
      const done = ['completed'].includes(p.status);
      const finalStatus = p.invoice ? (p.invoice === 'paid' ? 'paid' : 'invoiced') : p.status;
      const wo = await db.one(`INSERT INTO work_orders (tenant_id, branch_id, number, customer_id, address_id, asset_id, service_category_id, title, description, priority, status, scheduled_start,
          expected_duration_minutes, actual_start, actual_end, assigned_technician_id, estimated_cost, hold_reason, cancellation_reason, created_by, created_at, accepted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [tenantId, branchId, await nextNumber(db, 'job'), cust.id, cust.addressId, asset.id, cat.id, `${cat.name} — ${problem.split(',')[0]}`, problem,
          /trips|leak/i.test(problem) ? 'high' : i === 23 ? 'urgent' : 'normal', finalStatus, start, duration,
          done || p.status === 'in_progress' ? (p.status === 'in_progress' ? new Date(Date.now() - 40 * 60000) : new Date(start!.getTime() + 10 * 60000)) : null,
          done ? new Date(start!.getTime() + (duration + int(-10, 30)) * 60000) : null, tech, 599 + int(0, 8) * 250, p.hold ?? null, p.cancelled ?? null, userIds.dispatcher, created,
          tech && !['assigned'].includes(p.status) ? created : null]);
      jobs.push({ ...wo, plan: p });
      if (tech && start) await db.query(`INSERT INTO job_assignments (tenant_id, work_order_id, technician_id, time_window, is_current, assigned_by, assigned_at)
          VALUES ($1,$2,$3, tstzrange($4, $5, '[)'), true, $6, $7)`, [tenantId, wo.id, tech, start, new Date(start.getTime() + duration * 60000), userIds.dispatcher, created]);
      const path = { new: ['new'], approved: ['new', 'approved'], scheduled: ['new', 'approved', 'scheduled'], assigned: ['new', 'approved', 'assigned'], en_route: ['new', 'approved', 'assigned', 'en_route'],
        in_progress: ['new', 'approved', 'assigned', 'en_route', 'in_progress'], on_hold: ['new', 'approved', 'assigned', 'in_progress', 'on_hold'], cancelled: ['new', 'approved', 'cancelled'],
        rejected: ['new', 'rejected'], completed: ['new', 'approved', 'assigned', 'en_route', 'in_progress', 'completed'] }[p.status]!;
      let prev: string | null = null; let t = created.getTime();
      for (const s of path) {
        await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, wo.id, prev, s, s === 'on_hold' ? p.hold : s === 'cancelled' || s === 'rejected' ? p.cancelled : null, s === 'in_progress' || s === 'en_route' || s === 'completed' ? userIds.techs[0] : userIds.dispatcher, new Date(t)]);
        prev = s; t = Math.min(t + 3 * 3600000, (start?.getTime() ?? Date.now()) + duration * 60000);
      }
      if (done || p.status === 'in_progress' || p.status === 'on_hold') {
        const part = items[[0, 2, 7, 12, 3][i % 5]];
        const qty = part.name.includes('Gas') ? 1.5 : 1;
        if (done || i % 2 === 0) {
          const txn = await moveStock(db, { itemId: part.id, locationId: loc, quantityChange: -qty, type: 'job_usage', unitCost: part.cost, referenceType: 'work_order', referenceId: wo.id, reason: `Used on ${wo.number}`, userId: userIds.techs[0] });
          await db.query(`INSERT INTO work_order_parts (tenant_id, work_order_id, item_id, location_id, description, quantity, unit_price, unit_cost, inventory_txn_id, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, wo.id, part.id, loc, part.name, qty, part.price, part.cost, txn.id, userIds.techs[0]]);
        }
        await db.query(`INSERT INTO work_order_labour (tenant_id, work_order_id, technician_id, description, hours, rate) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, wo.id, tech, cat.name, Math.max(1, Math.round(duration / 60)), Number((await db.one(`SELECT default_price FROM service_categories WHERE id = $1`, [cat.id])).default_price)]);
      }
      if (done) {
        await db.query(`INSERT INTO service_reports (tenant_id, work_order_id, reported_issue, findings, work_performed, recommendations, equipment_condition, follow_up_required, customer_signed_name, customer_approved_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tenantId, wo.id, problem,
            pick(['Indoor coil heavily clogged with dust; drain line partially blocked.', 'Refrigerant pressure low (~45 psi); minor leak at flare joint.', 'Run capacitor bulged and below rated capacitance.', 'Outdoor fan blade loose; mounting bolts corroded.']),
            pick(['Jet-cleaned indoor coil and filters, flushed drain line, tested cooling (supply air 12°C).', 'Fixed flare leak, vacuumed system and recharged refrigerant to spec. Cooling restored.', 'Replaced run capacitor, checked compressor amperage within limits.', 'Tightened fan assembly, replaced bolts, lubricated motor bearings.']),
            pick(['Service every 4 months during summer.', 'Install a voltage stabiliser to protect the compressor.', 'Keep outdoor unit clear of plants and debris.', 'Consider an AMC for regular preventive maintenance.']),
            pick(['good', 'good', 'fair', 'fair', 'poor']), rnd() > 0.8, cust.name, wo.actual_end, userIds.techs[0]]);
        await db.query(`UPDATE assets SET last_service_date = $2::timestamptz::date, next_service_due = $2::timestamptz::date + 120 WHERE id = $1`, [asset.id, wo.actual_end]);
      }
      if (['completed', 'invoiced', 'paid'].includes(finalStatus) && done) {
        const rating = int(3, 5);
        if (i % 3 !== 2) await db.query(`INSERT INTO customer_feedback (tenant_id, customer_id, work_order_id, technician_id, rating, technician_rating, comment, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, cust.id, wo.id, tech, i === 7 ? 2 : rating, i === 7 ? 2 : rating, i === 7 ? 'Technician arrived 2 hours late and did not call.' : pick(['Very professional and quick.', 'Good service, explained the problem clearly.', 'AC is cooling well now. Thanks!', 'Neat work, cleaned up after.']), wo.actual_end]);
      }
    }
    // A few open service requests
    const reqs = [['Two ACs need servicing before guests arrive this weekend', 'portal', 'new'], ['AC making clicking sound and not starting', 'phone', 'under_review'],
      ['Need quote for 3 new split ACs in office', 'public_form', 'approved'], ['Water dripping from AC in the morning', 'whatsapp', 'new']];
    for (let k = 0; k < reqs.length; k++) {
      const c = customers[20 + k];
      await db.query(`INSERT INTO service_requests (tenant_id, branch_id, number, customer_id, address_id, contact_name, contact_phone, description, priority, source, status, preferred_date, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'+91 98000 1000${k}',$7,$8,$9,$10, current_date + $11::int, now() - ($12 || ' hours')::interval)`,
        [tenantId, branchId, await nextNumber(db, 'request'), c.id, c.addressId, c.name, reqs[k][0], k === 1 ? 'high' : 'normal', reqs[k][1], reqs[k][2], k + 1, String(4 + k * 9)]);
    }

    // ---------------------------------------------------------------- 10 invoices (8 from jobs, 2 AMC) and payments
    const seller = { name: 'CoolCare Services Pvt Ltd', address: '42, 2nd Floor, 80 Feet Road, Koramangala 4th Block, Bengaluru, Karnataka, 560034', email: 'hello@coolcare.example',
      phone: '+91 80 4567 8900', tax_label: 'GSTIN', tax_id: '29ABCDE1234F1Z5', country: 'IN' };
    const gstRate = await db.one(`SELECT id, rate, components FROM tax_rates WHERE id = $1`, [gst18]);
    async function seedInvoice(customerIdx: number, lines: { type: string; desc: string; qty: number; price: number; itemId?: string }[], issuedDaysAgo: number,
      link: { workOrderId?: string; amcId?: string }) {
      const c = customers[customerIdx];
      const calc = lines.map((l) => ({ ...l, ...calcLine({ quantity: l.qty, unitPrice: l.price, taxRate: Number(gstRate.rate), taxComponents: gstRate.components }) }));
      const tot = calcTotals(calc);
      const inv = await db.one(`INSERT INTO invoices (tenant_id, branch_id, customer_id, work_order_id, amc_contract_id, currency, subtotal, discount_total, tax_total, total, tax_breakdown, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9,$10,$11, now() - ($12 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, c.id, link.workOrderId ?? null, link.amcId ?? null, tot.subtotal, tot.discount_total, tot.tax_total, tot.total, JSON.stringify(tot.tax_breakdown), userIds.accountant, String(issuedDaysAgo)]);
      let pos = 0;
      for (const l of calc) await db.query(`INSERT INTO invoice_items (tenant_id, invoice_id, position, item_type, inventory_item_id, description, quantity, unit_price, tax_rate_id, tax_rate, tax_components,
          line_subtotal, line_discount, line_tax, line_total, hsn_sac_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [tenantId, inv.id, pos++, l.type, l.itemId ?? null, l.desc, l.qty, l.price, gst18, gstRate.rate, JSON.stringify(l.tax_components), l.line_subtotal, l.line_discount, l.line_tax, l.line_total,
          l.type === 'part' ? '8415' : '998719']);
      // back-dated issue (draft -> issued in one update is permitted by the immutability trigger)
      await db.query(`UPDATE invoices SET status = 'issued', number = $2, issue_date = current_date - $3::int, due_date = current_date - $3::int + 15, issued_at = now() - ($3 || ' days')::interval,
          issued_by = $4, bill_to = $5, seller = $6, place_of_supply = 'Karnataka' WHERE id = $1`,
        [inv.id, await nextNumber(db, 'invoice'), issuedDaysAgo, userIds.accountant, JSON.stringify({ name: c.name, address: `${c.area.name}, Bengaluru`, phone: null }), JSON.stringify(seller)]);
      await recomputeInvoice(db, null, inv.id);
      return { id: inv.id, total: tot.total };
    }
    async function seedPayment(invoiceId: string, customerIdx: number, amount: number, daysAgo: number, method: string) {
      await db.query(`INSERT INTO payments (tenant_id, invoice_id, customer_id, receipt_number, amount, currency, method, status, provider, reference, received_at, recorded_by, reconciled_at)
        VALUES ($1,$2,$3,$4,$5,'INR',$6,'succeeded','manual',$7, now() - ($8 || ' days')::interval, $9, CASE WHEN $8::int > 10 THEN now() ELSE NULL END)`,
        [tenantId, invoiceId, customers[customerIdx].id, await nextNumber(db, 'receipt'), amount, method, method === 'upi' ? `UPI${int(100000000, 999999999)}` : method === 'bank_transfer' ? `NEFT${int(10000, 99999)}` : null,
          String(daysAgo), userIds.accountant]);
      await recomputeInvoice(db, null, invoiceId);
    }
    for (const j of jobs.filter((x) => x.plan.invoice)) {
      const ci = customers.findIndex((c) => c.id === j.customer_id);
      const parts = await db.many(`SELECT item_id, description, quantity, unit_price FROM work_order_parts WHERE work_order_id = $1`, [j.id]);
      const labour = await db.many(`SELECT description, hours, rate FROM work_order_labour WHERE work_order_id = $1`, [j.id]);
      const daysAgo = -j.plan.dayOffset - 1;
      const inv = await seedInvoice(ci, [...labour.map((l: any) => ({ type: 'labour', desc: l.description, qty: Number(l.hours), price: Number(l.rate) })),
        ...parts.map((p: any) => ({ type: 'part', desc: p.description, qty: Number(p.quantity), price: Number(p.unit_price), itemId: p.item_id }))], daysAgo, { workOrderId: j.id });
      if (j.plan.invoice === 'paid') await seedPayment(inv.id, ci, inv.total, Math.max(1, daysAgo - int(1, 8)), pick(['upi', 'cash', 'bank_transfer', 'card']));
      if (j.plan.invoice === 'partial') await seedPayment(inv.id, ci, Math.round(inv.total * 0.5), Math.max(1, daysAgo - 2), 'upi');
    }

    // ---------------------------------------------------------------- 5 AMC contracts (2 invoiced)
    const amcDefs = [{ ci: 1, months: -10, freq: 'quarterly', value: 5999, invoice: 'paid' }, { ci: 2, months: -4, freq: 'quarterly', value: 7499, invoice: 'issued' },
      { ci: 3, months: -11, freq: 'half_yearly', value: 3499 }, { ci: 9, months: -2, freq: 'monthly', value: 18999 }, { ci: 5, months: -12, freq: 'quarterly', value: 6499, expired: true }];
    for (const d of amcDefs) {
      const c = customers[d.ci];
      const s = new Date(); s.setUTCMonth(s.getUTCMonth() + d.months); s.setUTCDate(1);
      const e = new Date(s); e.setUTCFullYear(e.getUTCFullYear() + 1); e.setUTCDate(e.getUTCDate() - 1);
      const visits = { monthly: 12, quarterly: 4, half_yearly: 2 }[d.freq]!;
      const m = await db.one(`INSERT INTO amc_contracts (tenant_id, branch_id, number, customer_id, address_id, service_category_id, title, start_date, end_date, frequency, visits_included, contract_value,
          currency, coverage, exclusions, status, auto_renew, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'INR',$13,$14,$15,$16,$17) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'amc'), c.id, c.addressId, cats.find((x) => x.name === 'AC Servicing')!.id, d.ci === 9 ? 'Comprehensive AMC — 6 office ACs' : 'Annual maintenance — split ACs',
          s.toISOString().slice(0, 10), e.toISOString().slice(0, 10), d.freq, visits, d.value, 'Preventive maintenance, coil cleaning, gas pressure check, minor electrical repairs, labour on breakdown visits.',
          'Spare parts, gas refill above 500 g, physical damage, compressor replacement.', 'active', d.ci === 9, userIds.admin1]);
      for (const asset of assets.filter((a) => a.customerIdx === d.ci).slice(0, 3)) await db.query(`INSERT INTO amc_contract_assets (tenant_id, contract_id, asset_id) VALUES ($1,$2,$3)`, [tenantId, m.id, asset.id]);
      await generateVisits(db, m.id);
      await db.query(`UPDATE scheduled_visits SET status = 'completed', completed_at = due_date::timestamptz + interval '10 hours' WHERE contract_id = $1 AND due_date < current_date - 5`, [m.id]);
      if (d.expired) await db.query(`UPDATE amc_contracts SET status = 'active' WHERE id = $1`, [m.id]);
      if (d.invoice) {
        const inv = await seedInvoice(d.ci, [{ type: 'amc', desc: `Annual maintenance contract (${visits} visits)`, qty: 1, price: d.value }], Math.max(1, -d.months * 30), { amcId: m.id });
        if (d.invoice === 'paid') await seedPayment(inv.id, d.ci, inv.total, Math.max(1, -d.months * 30 - 5), 'bank_transfer');
        await db.query(`UPDATE amc_contracts SET payment_status = $2 WHERE id = $1`, [m.id, d.invoice === 'paid' ? 'paid' : 'unpaid']);
      }
    }

    // ---------------------------------------------------------------- 10 quotations in different states
    const qStates = ['draft', 'sent', 'viewed', 'approved', 'approved', 'rejected', 'expired', 'sent', 'approved', 'draft'];
    for (let k = 0; k < 10; k++) {
      const ci = 30 + k * 3;
      const c = customers[ci];
      const install = k % 3 === 0;
      const lines = install
        ? [{ type: 'labour', desc: 'Split AC installation (standard)', qty: 2, price: 1999 }, { type: 'part', desc: 'Copper Pipe 1/2" (per m)', qty: 6, price: 580, itemId: items[9].id },
          { type: 'part', desc: 'Outdoor Unit Wall Stand', qty: 2, price: 950, itemId: items[10].id }]
        : [{ type: 'labour', desc: 'Compressor diagnosis & repair', qty: 1, price: 1499 }, { type: 'part', desc: 'R32 Refrigerant Gas (1 kg)', qty: 1.5, price: 1200, itemId: items[0].id },
          { type: 'part', desc: 'Run Capacitor 35+5 MFD', qty: 1, price: 450, itemId: items[2].id }];
      const calc = lines.map((l) => ({ ...l, ...calcLine({ quantity: l.qty, unitPrice: l.price, discountPercent: k === 4 ? 10 : 0, taxRate: Number(gstRate.rate), taxComponents: gstRate.components }) }));
      const tot = calcTotals(calc);
      const st = qStates[k];
      const daysAgo = int(2, 40);
      const q = await db.one(`INSERT INTO quotations (tenant_id, branch_id, number, customer_id, title, status, currency, issue_date, valid_until, subtotal, discount_total, tax_total, total, tax_breakdown,
          terms, sent_at, viewed_at, approved_at, approved_by_name, rejected_at, rejection_reason, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,'draft','INR', current_date - $6::int, current_date - $6::int + $7::int, $8,$9,$10,$11,$12,$13,
          CASE WHEN $14 <> 'draft' THEN now() - ($6 || ' days')::interval END, CASE WHEN $14 IN ('viewed','approved','rejected') THEN now() - ($6 || ' days')::interval + interval '5 hours' END,
          CASE WHEN $14 = 'approved' THEN now() - ($6 || ' days')::interval + interval '1 day' END, CASE WHEN $14 = 'approved' THEN $15 END,
          CASE WHEN $14 = 'rejected' THEN now() - ($6 || ' days')::interval + interval '2 days' END, CASE WHEN $14 = 'rejected' THEN 'Found a cheaper option' END, $16, now() - ($6 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'quotation'), c.id, install ? 'Installation of 2 split ACs' : 'Repair estimate — cooling issue', daysAgo, st === 'expired' ? 10 : 30,
          tot.subtotal, tot.discount_total, tot.tax_total, tot.total, JSON.stringify(tot.tax_breakdown), '50% advance for installations. Prices valid for 30 days.', st, c.name, userIds.admin1]);
      await db.query(`UPDATE quotations SET root_quotation_id = id WHERE id = $1`, [q.id]);
      let pos = 0;
      for (const l of calc) await db.query(`INSERT INTO quotation_items (tenant_id, quotation_id, position, item_type, inventory_item_id, description, quantity, unit_price, discount_percent, tax_rate_id, tax_rate,
          tax_components, line_subtotal, line_discount, line_tax, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [tenantId, q.id, pos++, l.type, (l as any).itemId ?? null, l.desc, l.qty, l.price, k === 4 ? 10 : 0, gst18, gstRate.rate, JSON.stringify(l.tax_components), l.line_subtotal, l.line_discount, l.line_tax, l.line_total]);
      if (st !== 'draft') await db.query(`UPDATE quotations SET status = $2 WHERE id = $1`, [q.id, st]);
    }

    // ---------------------------------------------------------------- tickets, notifications, comms, a little audit history
    const t = await db.one(`INSERT INTO support_tickets (tenant_id, number, customer_id, subject, category, priority, status) VALUES ($1,$2,$3,'Technician arrived late','complaint','high','open') RETURNING id`,
      [tenantId, await nextNumber(db, 'ticket'), jobs[7].customer_id]);
    await db.query(`INSERT INTO ticket_messages (tenant_id, ticket_id, author_type, body) VALUES ($1,$2,'customer','The technician came two hours after the slot and did not call ahead.')`, [tenantId, t.id]);
    for (const c of customers.slice(0, 15)) await db.query(`INSERT INTO communications (tenant_id, customer_id, channel, direction, subject, body, user_id, created_at)
      VALUES ($1,$2,'phone','inbound',NULL,'Called to check service availability; booked a visit.',$3, now() - ($4 || ' days')::interval)`, [tenantId, c.id, userIds.dispatcher, String(int(1, 60))]);
    await db.query(`INSERT INTO notifications (tenant_id, user_id, event, title, body, link) VALUES ($1,$2,'request.created','New service request','Two ACs need servicing before guests arrive','/app/requests')`, [tenantId, userIds.owner]);
    await db.query(`INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, created_at) VALUES ($1,$2,'owner@coolcare.example','demo.seeded','tenant', now())`, [tenantId, userIds.owner]);
  });
  logger.info({ tenantId }, 'demo tenant seeded');
  return tenantId;
}
