/**
 * Showcase companies: five sample service businesses in different trades and countries, each with
 * staff logins and ~50 jobs across the whole lifecycle (spread over five months, plus the coming week),
 * customers, equipment, quotations, invoices, payments, maintenance contracts, requests and ratings.
 * Every figure on their dashboards is computed from these records at query time.
 *
 * They are ordinary active subscribers (so the Super Admin dashboard shows them); all e-mail domains
 * are *.example. Idempotent: an existing company (by workspace slug) is skipped.
 * Enable on boot with SEED_SHOWCASE=true, or run `npm run seed:showcase -w server`.
 */
import { systemDb, withSystem, withTenant, type Db } from '../db/pool.js';
import { hashPassword } from '../lib/crypto.js';
import { nextNumber } from '../lib/numbering.js';
import { calcLine, calcTotals } from '../lib/money.js';
import { logger } from '../logger.js';
import { provisionTenant, assignRole, applyCategoryPreset } from '../modules/tenants/provision.js';
import { bootstrapReferenceData } from '../auth/bootstrap.js';
import { recomputeInvoice } from '../modules/invoices/service.js';
import { generateVisits } from '../modules/amc/routes.js';

export const SHOWCASE_PASSWORD = process.env.SHOWCASE_PASSWORD || 'Demo@2026';

interface Profile {
  slug: string; name: string; legal: string; preset: string; country: string; plan: string; cycle: 'monthly' | 'annual';
  city: string; state: string | null; areas: { name: string; pin: string }[]; streets: string[]; utcOffset: number;
  first: string[]; last: string[]; companies: string[]; phone: (i: number) => string; taxId: string;
  /** service category name → price; parts list [description, price] */
  prices: Record<string, number>; parts: [string, number][]; problems: string[]; brands: string[];
  people: { owner: string; dispatcher: string; accountant: string; techs: string[] };
  hsn?: { labour: string; part: string };
}

const IN_FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Ananya', 'Diya', 'Saanvi', 'Meera', 'Kavya', 'Priya', 'Rahul', 'Neha', 'Varun', 'Pooja', 'Amit', 'Sunita', 'Vikram', 'Anjali', 'Karan'];
const IN_LAST = ['Sharma', 'Verma', 'Gupta', 'Malhotra', 'Kapoor', 'Mehta', 'Joshi', 'Patil', 'Deshmukh', 'Kulkarni', 'Shah', 'Agarwal', 'Singh', 'Chopra', 'Bansal'];

export const SHOWCASE: Profile[] = [
  {
    slug: 'sharma-electricals', name: 'Sharma Electricals', legal: 'Sharma Electricals Pvt Ltd', preset: 'electrical', country: 'IN', plan: 'growth', cycle: 'monthly',
    city: 'New Delhi', state: 'Delhi', utcOffset: 5.5, taxId: '07AAGCS1234K1Z3',
    areas: [{ name: 'Saket', pin: '110017' }, { name: 'Lajpat Nagar', pin: '110024' }, { name: 'Dwarka', pin: '110075' }, { name: 'Rohini', pin: '110085' }, { name: 'Karol Bagh', pin: '110005' }],
    streets: ['Main Road', 'Block C', 'Sector 12', 'Ring Road', 'Market Lane'], first: IN_FIRST, last: IN_LAST,
    companies: ['Sunrise Clinic', 'Galaxy Offices', 'Annapurna Restaurant', 'Delhi Public Library', 'Metro Mart'],
    phone: (i) => `+91 98110 ${String(10000 + i * 371).slice(0, 5)}`,
    prices: { 'Wiring': 2500, 'Electrical Repair': 450, 'Panel Installation': 6500, 'Inspection': 350 },
    parts: [['MCB 32A Double Pole', 650], ['Copper Wire 2.5 sq mm (90 m)', 2400], ['LED Panel Light 18W', 550], ['Modular Switch Board', 380], ['RCCB 40A', 2100]],
    problems: ['Frequent power trips in the kitchen', 'Sparks from the main switch board', 'New wiring for the renovated flat', 'Inverter not charging the battery', 'Half the house has no power', 'Annual electrical safety inspection', 'Install new distribution panel for office', 'Lights flickering in all rooms'],
    brands: ['Havells', 'Anchor', 'Legrand', 'Schneider', 'Luminous'],
    people: { owner: 'Rakesh Sharma', dispatcher: 'Pooja Mehta', accountant: 'Anil Gupta', techs: ['Sunil Kumar', 'Manoj Yadav', 'Deepak Rawat', 'Imran Khan'] },
    hsn: { labour: '998719', part: '8536' },
  },
  {
    slug: 'aquafix', name: 'AquaFix Plumbing', legal: 'AquaFix Plumbing Services LLP', preset: 'plumbing', country: 'IN', plan: 'starter', cycle: 'monthly',
    city: 'Mumbai', state: 'Maharashtra', utcOffset: 5.5, taxId: '27AAKFA5678L1Z9',
    areas: [{ name: 'Andheri West', pin: '400053' }, { name: 'Bandra', pin: '400050' }, { name: 'Powai', pin: '400076' }, { name: 'Thane West', pin: '400601' }, { name: 'Malad', pin: '400064' }],
    streets: ['Link Road', 'SV Road', 'Hill Road', 'Station Road', 'LBS Marg'], first: IN_FIRST, last: IN_LAST,
    companies: ['Seaview Apartments', 'Blue Lotus Hotel', 'Powai Tech Park', 'Krishna Hospital', 'Café Mocha'],
    phone: (i) => `+91 98200 ${String(20000 + i * 413).slice(0, 5)}`,
    prices: { 'Leak Repair': 499, 'Pipe Installation': 1800, 'Drain Cleaning': 699, 'Water Heater Service': 899 },
    parts: [['CPVC Pipe 1" (3 m)', 420], ['Ball Valve 1/2"', 280], ['Geyser Heating Element 2kW', 950], ['Flush Valve Kit', 1150], ['Kitchen Sink Mixer', 2600]],
    problems: ['Kitchen sink completely blocked', 'Water leaking from bathroom ceiling', 'Geyser not heating water', 'Low water pressure in all taps', 'Toilet flush running continuously', 'New bathroom pipeline fitting', 'Overhead tank overflowing', 'Annual pump and tank maintenance'],
    brands: ['Racold', 'AO Smith', 'Kirloskar', 'Jaquar', 'Crompton'],
    people: { owner: 'Farhan Shaikh', dispatcher: 'Sneha Patil', accountant: 'Prakash Desai', techs: ['Santosh More', 'Ganesh Pawar', 'Joseph Dsouza', 'Ramesh Jadhav'] },
    hsn: { labour: '998719', part: '3917' },
  },
  {
    slug: 'safeeye', name: 'SafeEye Security Systems', legal: 'SafeEye Security Systems LLC', preset: 'cctv', country: 'AE', plan: 'business', cycle: 'annual',
    city: 'Dubai', state: 'Dubai', utcOffset: 4, taxId: '100234567800003',
    areas: [{ name: 'Business Bay', pin: '00000' }, { name: 'Dubai Marina', pin: '00000' }, { name: 'Deira', pin: '00000' }, { name: 'Al Barsha', pin: '00000' }, { name: 'JLT', pin: '00000' }],
    streets: ['Sheikh Zayed Road', 'Al Wasl Road', 'Marina Walk', 'Al Khail Road', 'Baniyas Road'],
    first: ['Ahmed', 'Fatima', 'Omar', 'Aisha', 'Yusuf', 'Mariam', 'Khalid', 'Sara', 'Rashid', 'Layla', 'John', 'Priya', 'Mohammed', 'Noor', 'David'],
    last: ['Al Mansoori', 'Al Hashimi', 'Khan', 'Haddad', 'Rahman', 'Nasser', 'Smith', 'Fernandes', 'Al Falasi', 'Saleh'],
    companies: ['Marina Heights Tower', 'Golden Sands Hotel', 'Al Noor Pharmacy', 'Skyline Offices', 'Desert Rose Villas'],
    phone: (i) => `+971 50 ${String(1000000 + i * 7331).slice(0, 7)}`,
    prices: { 'CCTV Installation': 2400, 'CCTV Maintenance': 350, 'DVR/NVR Configuration': 450 },
    parts: [['4MP Dome IP Camera', 480], ['8-Channel NVR', 1150], ['4TB Surveillance HDD', 520], ['PoE Switch 8-port', 390], ['Cat6 Cable (305 m)', 610]],
    problems: ['Two cameras showing no video', 'Install 8-camera system in new villa', 'NVR not recording since power cut', 'Remote viewing app stopped working', 'Quarterly maintenance visit', 'Add cameras to the parking area', 'Camera image blurry at night', 'Hard disk full warning on NVR'],
    brands: ['Hikvision', 'Dahua', 'Axis', 'Uniview', 'Bosch'],
    people: { owner: 'Khalid Al Hashimi', dispatcher: 'Maria Fernandes', accountant: 'Rahul Nair', techs: ['Ali Raza', 'Joseph Mathew', 'Bilal Ahmed', 'Kevin Santos'] },
  },
  {
    slug: 'sunpower', name: 'SunPower Solar', legal: 'SunPower Soluciones Solares S.L.', preset: 'solar', country: 'ES', plan: 'business', cycle: 'monthly',
    city: 'Madrid', state: 'Madrid', utcOffset: 1, taxId: 'ESB12345678',
    areas: [{ name: 'Chamberí', pin: '28010' }, { name: 'Salamanca', pin: '28006' }, { name: 'Pozuelo', pin: '28223' }, { name: 'Alcobendas', pin: '28100' }, { name: 'Getafe', pin: '28901' }],
    streets: ['Calle Mayor', 'Avenida de América', 'Calle de Alcalá', 'Paseo de la Castellana', 'Calle Real'],
    first: ['Lucía', 'Hugo', 'Martina', 'Mateo', 'Sofía', 'Pablo', 'Elena', 'Daniel', 'Carmen', 'Javier', 'Laura', 'Diego', 'Isabel', 'Álvaro', 'Paula'],
    last: ['García', 'Martínez', 'López', 'Sánchez', 'Pérez', 'Gómez', 'Fernández', 'Ruiz', 'Díaz', 'Moreno'],
    companies: ['Hotel Sol Madrid', 'Bodegas Ribera', 'Colegio San José', 'Oficinas Castellana', 'Granja El Prado'],
    phone: (i) => `+34 6${String(10000000 + i * 91733).slice(0, 8)}`,
    prices: { 'Solar Installation': 4800, 'Panel Cleaning': 120, 'Inverter Service': 180, 'Performance Audit': 250 },
    parts: [['Panel solar 450 W', 210], ['Inversor híbrido 5 kW', 1350], ['Optimizador de potencia', 85], ['Cableado solar 6 mm² (50 m)', 95], ['Batería litio 5 kWh', 2400]],
    problems: ['Production dropped 30% this month', 'Inverter showing error code', 'New 6 kW rooftop installation', 'Annual panel cleaning and inspection', 'Battery not charging overnight', 'Monitoring app offline', 'Add battery storage to existing system', 'Performance audit for subsidy claim'],
    brands: ['Huawei', 'SMA', 'Fronius', 'JinkoSolar', 'LONGi'],
    people: { owner: 'Javier Ruiz', dispatcher: 'Carmen López', accountant: 'Elena Moreno', techs: ['Pablo Sánchez', 'Diego Martín', 'Sergio Gil', 'Andrés Navarro'] },
  },
  {
    slug: 'kaelte-service', name: 'Kälte Service Berlin', legal: 'Kälte Service Berlin GmbH', preset: 'hvac', country: 'DE', plan: 'enterprise', cycle: 'annual',
    city: 'Berlin', state: 'Berlin', utcOffset: 1, taxId: 'DE287654321',
    areas: [{ name: 'Mitte', pin: '10115' }, { name: 'Charlottenburg', pin: '10585' }, { name: 'Kreuzberg', pin: '10997' }, { name: 'Prenzlauer Berg', pin: '10405' }, { name: 'Spandau', pin: '13597' }],
    streets: ['Hauptstraße', 'Friedrichstraße', 'Kantstraße', 'Bergmannstraße', 'Schönhauser Allee'],
    first: ['Lukas', 'Anna', 'Felix', 'Marie', 'Jonas', 'Laura', 'Leon', 'Sophie', 'Paul', 'Lena', 'Max', 'Hannah', 'Tim', 'Julia', 'Ben'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Hoffmann', 'Koch'],
    companies: ['Hotel Spree', 'Bäckerei Krause', 'Praxis Dr. Weber', 'Büro am Alex', 'Supermarkt Nord'],
    phone: (i) => `+49 30 ${String(2000000 + i * 4129).slice(0, 7)}`,
    prices: { 'AC Installation': 1450, 'AC Repair': 145, 'AC Servicing': 120, 'Gas Refilling': 260, 'AC Uninstallation': 180 },
    parts: [['Kältemittel R32 (1 kg)', 95], ['Kondensator 35 µF', 38], ['Innengeräte-Lüftermotor', 210], ['Kondensatpumpe', 145], ['Filterset', 45]],
    problems: ['Klimaanlage kühlt nicht mehr', 'Wasser tropft aus dem Innengerät', 'Neue Split-Klimaanlage im Büro', 'Jährliche Wartung fällig', 'Lautes Geräusch vom Außengerät', 'Fehlercode E4 auf der Anzeige', 'Kühlraum erreicht Temperatur nicht', 'Kältemittel nachfüllen'],
    brands: ['Daikin', 'Mitsubishi', 'Panasonic', 'LG', 'Fujitsu'],
    people: { owner: 'Thomas Becker', dispatcher: 'Julia Hoffmann', accountant: 'Stefan Koch', techs: ['Lukas Wagner', 'Jonas Fischer', 'Mehmet Yilmaz', 'Felix Schulz'] },
  },
];

// Deterministic PRNG so the showcase is identical on every install
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

type Plan = { status: string; day: number; invoice?: 'paid' | 'unpaid' | 'overdue' | 'partial'; reason?: string };
/** 50 jobs: 30 completed (most invoiced and paid) over ~5 months, some cancelled/on hold, today's jobs and the coming week. */
function jobPlans(): Plan[] {
  const past = [-148, -141, -133, -126, -119, -112, -106, -99, -93, -86, -80, -73, -67, -61, -55, -49, -44, -38, -33, -28, -24, -20, -17, -14, -11, -9, -7, -5, -3, -2];
  const completed: Plan[] = past.map((day, i) => ({ status: 'completed', day,
    invoice: i < 22 ? 'paid' : i < 25 ? 'overdue' : i < 27 ? 'partial' : i === 27 ? 'unpaid' : undefined }));
  return [
    ...completed,
    { status: 'cancelled', day: -130, reason: 'Customer moved out' }, { status: 'cancelled', day: -95, reason: 'Duplicate booking' },
    { status: 'cancelled', day: -58, reason: 'Customer fixed it themselves' }, { status: 'cancelled', day: -21, reason: 'Rescheduled by phone, new job created' },
    { status: 'rejected', day: -40, reason: 'Outside our service area' },
    { status: 'on_hold', day: -4, reason: 'Waiting for spare part from supplier' },
    { status: 'in_progress', day: 0 }, { status: 'in_progress', day: 0 }, { status: 'en_route', day: 0 }, { status: 'assigned', day: 0 },
    { status: 'assigned', day: 1 }, { status: 'assigned', day: 2 }, { status: 'assigned', day: 3 }, { status: 'assigned', day: 5 }, { status: 'assigned', day: 6 },
    { status: 'scheduled', day: 4 }, { status: 'scheduled', day: 8 }, { status: 'scheduled', day: 10 },
    { status: 'new', day: 0 }, { status: 'new', day: 0 }, { status: 'approved', day: 0 },
  ];
}

async function seedCompany(p: Profile, idx: number) {
  const existing = await systemDb.maybeOne(`SELECT id FROM tenants WHERE slug = $1`, [p.slug]);
  if (existing) { logger.info({ slug: p.slug }, 'showcase company exists; skipping'); return existing.id as string; }
  seed = 7919 * (idx + 1);
  const pw = await hashPassword(SHOWCASE_PASSWORD);
  const domain = `${p.slug}.example`;
  const area0 = p.areas[0];

  const { tenantId, branchId, users } = await withSystem(async (db) => {
    const { tenant, branchId } = await provisionTenant(db, { businessName: p.name, slug: p.slug, country: p.country, email: `hello@${domain}`, phone: p.phone(999),
      planCode: p.plan, billingCycle: p.cycle, isDemo: false });
    await db.query(`UPDATE tenants SET legal_name = $2, address_line1 = $3, city = $4, state = $5, postal_code = $6, business_category = $7, employee_count = 12, technician_count = 4,
      created_at = now() - interval '160 days' WHERE id = $1`, [tenant.id, p.legal, `${int(1, 120)} ${p.streets[0]}`, p.city, p.state, area0.pin, p.preset]);
    // Active paying subscriber (trial already converted)
    await db.query(`UPDATE subscriptions SET status = 'active', trial_ends_at = now() - interval '146 days', current_period_start = date_trunc('month', now()),
      current_period_end = date_trunc('month', now()) + CASE WHEN billing_cycle = 'annual' THEN interval '1 year' ELSE interval '1 month' END,
      price = CASE WHEN price = 0 THEN 4990 ELSE price END WHERE tenant_id = $1`, [tenant.id]); // Enterprise: negotiated annual price
    // Subscription payment history (paid NEXUS invoices) since the trial converted
    const sub = await db.one(`SELECT id, plan_id, price, currency, billing_cycle FROM subscriptions WHERE tenant_id = $1`, [tenant.id]);
    const periods = sub.billing_cycle === 'annual' ? [5] : [5, 4, 3, 2, 1, 0];
    for (const m of periods) await db.query(`INSERT INTO subscription_invoices (tenant_id, subscription_id, number, plan_id, period_start, period_end, amount, currency, status, paid_at, created_at)
      VALUES ($1,$2,$3,$4, date_trunc('month', now()) - ($5 || ' months')::interval, date_trunc('month', now()) - ($5 || ' months')::interval + CASE WHEN $8 = 'annual' THEN interval '1 year' ELSE interval '1 month' END,
        $6,$7,'paid', date_trunc('month', now()) - ($5 || ' months')::interval + interval '2 days', date_trunc('month', now()) - ($5 || ' months')::interval)`,
      [tenant.id, sub.id, `NX-${p.slug.slice(0, 4).toUpperCase()}-${String(6 - m).padStart(4, '0')}`, sub.plan_id, String(m), sub.price, sub.currency, sub.billing_cycle]);
    const mk = async (local: string, name: string, role: string, phone: string) => {
      const u = await db.one(`INSERT INTO users (tenant_id, branch_id, email, password_hash, full_name, phone, user_type, email_verified_at, last_login_at)
        VALUES ($1,$2,$3,$4,$5,$6,'staff', now(), now() - interval '3 hours') RETURNING id`, [tenant.id, branchId, `${local}@${domain}`, pw, name, phone]);
      await assignRole(db, u.id, tenant.id, role);
      return u.id as string;
    };
    const users = {
      owner: await mk('owner', p.people.owner, 'owner', p.phone(900)),
      dispatcher: await mk('dispatch', p.people.dispatcher, 'dispatcher', p.phone(901)),
      accountant: await mk('accounts', p.people.accountant, 'accountant', p.phone(902)),
      techs: [] as string[],
    };
    for (let i = 0; i < p.people.techs.length; i++) users.techs.push(await mk(i === 0 ? 'tech' : `tech${i + 1}`, p.people.techs[i], 'technician', p.phone(910 + i)));
    return { tenantId: tenant.id as string, branchId: branchId as string, users };
  });
  await applyCategoryPreset(tenantId, p.preset);

  await withTenant(tenantId, async (db: Db) => {
    const st = await db.one(`SELECT currency, timezone FROM tenant_settings WHERE tenant_id = $1`, [tenantId]);
    const currency = st.currency as string;
    await db.query(`UPDATE tenant_settings SET tax_registration_number = $2, onboarding_step = 5, onboarding_completed_at = now(), prevent_double_booking = true,
      invoice_footer = $3, quotation_terms = 'Prices valid for 30 days. 90-day workmanship warranty.' WHERE tenant_id = $1`,
      [tenantId, p.taxId, `Thank you for choosing ${p.name}.`]);
    for (const [name, price] of Object.entries(p.prices)) await db.query(`UPDATE service_categories SET default_price = $2 WHERE name = $1`, [name, price]);
    const cats = await db.many(`SELECT id, name, default_duration_minutes, default_price FROM service_categories ORDER BY name`);
    const eqCats = await db.many(`SELECT id, name FROM equipment_categories ORDER BY name`);
    const tax = await db.one(`SELECT id, rate, components FROM tax_rates WHERE is_active ORDER BY is_default DESC, rate DESC LIMIT 1`);
    const areaIds: string[] = [];
    for (const a of p.areas) areaIds.push((await db.one(`INSERT INTO service_areas (tenant_id, branch_id, name, postal_codes) VALUES ($1,$2,$3,$4) RETURNING id`, [tenantId, branchId, a.name, [a.pin]])).id);

    // technicians
    const techIds: string[] = [];
    for (let i = 0; i < users.techs.length; i++) {
      const tp = await db.one(`INSERT INTO technician_profiles (tenant_id, user_id, branch_id, employee_id, employment_type, hourly_cost, max_jobs_per_day)
        VALUES ($1,$2,$3,$4,'full_time',$5,5) RETURNING id`, [tenantId, users.techs[i], branchId, `T-${101 + i}`, 20 + i * 2]);
      techIds.push(tp.id);
      for (const c of cats) await db.query(`INSERT INTO technician_skills (tenant_id, technician_id, service_category_id, proficiency) VALUES ($1,$2,$3,$4)`, [tenantId, tp.id, c.id, int(3, 5)]);
      for (const k of [i % areaIds.length, (i + 2) % areaIds.length]) await db.query(`INSERT INTO technician_service_areas (tenant_id, technician_id, service_area_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, tp.id, areaIds[k]]);
      for (let d = 1; d <= 6; d++) await db.query(`INSERT INTO technician_availability (tenant_id, technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'08:00','19:00')`, [tenantId, tp.id, d]);
    }

    // 30 customers (every 5th a business) with addresses, spread over the last 5 months
    const customers: { id: string; addressId: string; name: string; areaIdx: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const biz = i % 5 === 0;
      const person = `${pick(p.first)} ${pick(p.last)}`;
      const ai = i % p.areas.length; const area = p.areas[ai];
      const phone = p.phone(i);
      const c = await db.one(`INSERT INTO customers (tenant_id, branch_id, number, customer_type, full_name, company_name, email, phone, phone_normalized, billing_line1, billing_city, billing_state,
          billing_postal_code, billing_country, source, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() - ($17 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'customer'), biz ? 'business' : 'individual', person, biz ? p.companies[(i / 5) % p.companies.length] : null,
          `customer${i + 1}@${domain}`, phone, phone.replace(/\D/g, '').slice(-10), `${int(1, 250)} ${pick(p.streets)}`, p.city, p.state, area.pin, p.country,
          pick(['referral', 'google', 'repeat', 'portal', 'phone']), users.dispatcher, String(155 - i * 5)]);
      const a = await db.one(`INSERT INTO customer_addresses (tenant_id, customer_id, label, line1, line2, city, state, postal_code, country, service_area_id, is_default)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) RETURNING id`,
        [tenantId, c.id, biz ? 'Office' : 'Home', `${int(1, 250)} ${pick(p.streets)}`, area.name, p.city, p.state, area.pin, p.country, areaIds[ai]]);
      customers.push({ id: c.id, addressId: a.id, name: biz ? p.companies[(i / 5) % p.companies.length] : person, areaIdx: ai });
    }
    // customer portal login for the first customer
    const portal = await db.one(`INSERT INTO users (tenant_id, email, password_hash, full_name, phone, user_type, email_verified_at) VALUES ($1,$2,$3,$4,$5,'customer', now()) RETURNING id`,
      [tenantId, `customer@${domain}`, pw, customers[1].name, p.phone(1)]);
    await db.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1,(SELECT id FROM roles WHERE key = 'customer' AND tenant_id IS NULL),$2)`, [portal.id, tenantId]);
    await db.query(`UPDATE customers SET portal_user_id = $2, email = $3 WHERE id = $1`, [customers[1].id, portal.id, `customer@${domain}`]);

    // 20 pieces of equipment
    const assets: { id: string; ci: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const ci = i < 6 ? i : int(0, 29);
      const eq = eqCats[i % eqCats.length];
      const ago = int(90, 1400);
      const install = new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
      const wexp = new Date(Date.now() - ago * 86400000 + 365 * (rnd() > 0.5 ? 3 : 1) * 86400000).toISOString().slice(0, 10);
      const brand = pick(p.brands);
      const a = await db.one(`INSERT INTO assets (tenant_id, number, customer_id, address_id, equipment_category_id, name, manufacturer, model, serial_number, installation_date, warranty_start, warranty_expiry, next_service_due)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11, current_date + $12::int) RETURNING id`,
        [tenantId, await nextNumber(db, 'asset'), customers[ci].id, customers[ci].addressId, eq.id, eq.name, brand, `${brand.slice(0, 3).toUpperCase()}-${int(100, 999)}`,
          `SN${int(10000000, 99999999)}`, install, wexp, int(-15, 150)]);
      assets.push({ id: a.id, ci });
    }

    // 50 jobs across the lifecycle
    const dayStart = (day: number) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() + day * 86400000; };
    const at = (day: number, localHour: number) => new Date(dayStart(day) + (localHour - p.utcOffset) * 3600000);
    const plans = jobPlans();
    const jobs: any[] = [];
    let todayTech = 0;
    for (let i = 0; i < plans.length; i++) {
      const pl = plans[i];
      const asset = assets[i % assets.length];
      const cust = customers[i < 20 ? asset.ci : (i * 7) % customers.length];
      const problem = p.problems[i % p.problems.length];
      const cat = cats[i % cats.length];
      const unscheduled = pl.status === 'new' || pl.status === 'approved';
      // one job per technician per day: past/future jobs are on distinct days; today's jobs use distinct technicians
      const techIdx = pl.day === 0 ? todayTech++ % techIds.length : i % techIds.length;
      const hour = pl.status === 'in_progress' ? null : pl.day === 0 ? 14 + techIdx : 9 + (i % 3) * 2;
      const start = unscheduled ? null : hour === null ? new Date(Math.round((Date.now() - (60 + techIdx * 30) * 60000) / 900000) * 900000) : at(pl.day, hour);
      const tech = ['scheduled', 'new', 'approved', 'cancelled', 'rejected'].includes(pl.status) ? null : techIds[techIdx];
      const duration = Math.min(cat.default_duration_minutes, 240);
      const created = new Date((start?.getTime() ?? Date.now()) - int(1, 3) * 86400000);
      const done = pl.status === 'completed';
      const finalStatus = pl.invoice ? (pl.invoice === 'paid' ? 'paid' : 'invoiced') : pl.status;
      const wo = await db.one(`INSERT INTO work_orders (tenant_id, branch_id, number, customer_id, address_id, asset_id, service_category_id, title, description, priority, status, scheduled_start,
          expected_duration_minutes, actual_start, actual_end, assigned_technician_id, estimated_cost, hold_reason, cancellation_reason, created_by, created_at, accepted_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [tenantId, branchId, await nextNumber(db, 'job'), cust.id, cust.addressId, i < 20 ? asset.id : null, cat.id, `${cat.name} — ${problem}`, problem,
          i % 11 === 0 ? 'urgent' : i % 4 === 0 ? 'high' : 'normal', finalStatus, start, duration,
          done ? new Date(start!.getTime() + 10 * 60000) : pl.status === 'in_progress' ? start : null,
          done ? new Date(start!.getTime() + (duration + int(-10, 25)) * 60000) : null, tech, Number(cat.default_price ?? 0), pl.status === 'on_hold' ? pl.reason : null,
          ['cancelled', 'rejected'].includes(pl.status) ? pl.reason : null, users.dispatcher, created, tech && pl.status !== 'assigned' ? created : null]);
      jobs.push({ ...wo, plan: pl, cust, cat });
      if (tech && start) await db.query(`INSERT INTO job_assignments (tenant_id, work_order_id, technician_id, time_window, is_current, assigned_by, assigned_at)
        VALUES ($1,$2,$3, tstzrange($4, $5, '[)'), true, $6, $7)`, [tenantId, wo.id, tech, start, new Date(start.getTime() + duration * 60000), users.dispatcher, created]);
      const path = ({ new: ['new'], approved: ['new', 'approved'], scheduled: ['new', 'approved', 'scheduled'], assigned: ['new', 'approved', 'assigned'],
        en_route: ['new', 'approved', 'assigned', 'en_route'], in_progress: ['new', 'approved', 'assigned', 'en_route', 'in_progress'],
        on_hold: ['new', 'approved', 'assigned', 'in_progress', 'on_hold'], cancelled: ['new', 'approved', 'cancelled'], rejected: ['new', 'rejected'],
        completed: ['new', 'approved', 'assigned', 'en_route', 'in_progress', 'completed'] } as Record<string, string[]>)[pl.status];
      let prev: string | null = null; let t = created.getTime();
      for (const s of path) {
        await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, wo.id, prev, s, ['on_hold', 'cancelled', 'rejected'].includes(s) ? pl.reason : null, ['en_route', 'in_progress', 'completed'].includes(s) && tech ? users.techs[techIdx] : users.dispatcher, new Date(t)]);
        prev = s; t = Math.min(t + 2 * 3600000, (start?.getTime() ?? Date.now()) + duration * 60000);
      }
      if (done || pl.status === 'in_progress' || pl.status === 'on_hold') {
        const [pname, pprice] = p.parts[i % p.parts.length];
        await db.query(`INSERT INTO work_order_parts (tenant_id, work_order_id, description, quantity, unit_price, unit_cost, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, wo.id, pname, 1 + (i % 3 === 0 ? 1 : 0), pprice, Math.round(pprice * 0.6), users.techs[techIdx]]);
        await db.query(`INSERT INTO work_order_labour (tenant_id, work_order_id, technician_id, description, hours, rate) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, wo.id, tech, cat.name, 1, Number(cat.default_price ?? 0)]);
      }
      if (done) {
        await db.query(`INSERT INTO service_reports (tenant_id, work_order_id, reported_issue, findings, work_performed, recommendations, equipment_condition, customer_signed_name, customer_approved_at, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, wo.id, problem, 'Inspected the system and identified the faulty component.',
            `Replaced ${p.parts[i % p.parts.length][0]}, tested the system end to end and confirmed normal operation.`, 'Schedule preventive maintenance in 6 months.',
            pick(['good', 'good', 'fair']), cust.name, wo.actual_end, users.techs[techIdx]]);
        if (i % 4 !== 3) await db.query(`INSERT INTO customer_feedback (tenant_id, customer_id, work_order_id, technician_id, rating, technician_rating, comment, created_at) VALUES ($1,$2,$3,$4,$5,$5,$6,$7)`,
          [tenantId, cust.id, wo.id, tech, i === 13 ? 2 : int(4, 5), i === 13 ? 'Arrived late and had to come back for a part.' : pick(['Quick and professional.', 'Explained everything clearly.', 'Very happy with the work.', 'Clean and tidy, thank you!']), wo.actual_end]);
      }
    }

    // invoices + payments for completed jobs
    const taxRate = Number(tax.rate);
    const seller = { name: p.legal, trade_name: p.name, address: `${p.streets[0]}, ${p.city}`, email: `hello@${domain}`, phone: p.phone(999), tax_label: null, tax_id: p.taxId, country: p.country,
      parts: { line1: p.streets[0], line2: null, city: p.city, state: p.state, postal_code: area0.pin, country: p.country } };
    async function seedInvoice(c: { id: string; name: string; areaIdx: number }, lines: { type: string; desc: string; qty: number; price: number }[], daysAgo: number, link: { workOrderId?: string; amcId?: string }) {
      const calc = lines.map((l) => ({ ...l, ...calcLine({ quantity: l.qty, unitPrice: l.price, taxRate, taxComponents: tax.components }) }));
      const tot = calcTotals(calc);
      const inv = await db.one(`INSERT INTO invoices (tenant_id, branch_id, customer_id, work_order_id, amc_contract_id, currency, subtotal, discount_total, tax_total, total, tax_breakdown, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - ($13 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, c.id, link.workOrderId ?? null, link.amcId ?? null, currency, tot.subtotal, tot.discount_total, tot.tax_total, tot.total, JSON.stringify(tot.tax_breakdown), users.accountant, String(daysAgo)]);
      let pos = 0;
      for (const l of calc) await db.query(`INSERT INTO invoice_items (tenant_id, invoice_id, position, item_type, description, quantity, unit_price, tax_rate_id, tax_rate, tax_components,
          line_subtotal, line_discount, line_tax, line_total, hsn_sac_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [tenantId, inv.id, pos++, l.type, l.desc, l.qty, l.price, tax.id, tax.rate, JSON.stringify(l.tax_components), l.line_subtotal, l.line_discount, l.line_tax, l.line_total,
          p.hsn ? (l.type === 'part' ? p.hsn.part : p.hsn.labour) : null]);
      const area = p.areas[c.areaIdx];
      await db.query(`UPDATE invoices SET status = 'issued', number = $2, issue_date = current_date - $3::int, due_date = current_date - $3::int + 15, issued_at = now() - ($3 || ' days')::interval,
          issued_by = $4, bill_to = $5, seller = $6, place_of_supply = $7 WHERE id = $1`,
        [inv.id, await nextNumber(db, 'invoice'), daysAgo, users.accountant,
          JSON.stringify({ name: c.name, address: `${area.name}, ${p.city}`, parts: { line1: area.name, city: p.city, state: p.state, postal_code: area.pin, country: p.country } }),
          JSON.stringify(seller), p.state]);
      await recomputeInvoice(db, null, inv.id);
      return { id: inv.id, total: Number(tot.total) };
    }
    async function pay(invoiceId: string, customerId: string, amount: number, daysAgo: number) {
      const method = pick(p.country === 'IN' ? ['upi', 'upi', 'cash', 'bank_transfer', 'card'] : ['card', 'bank_transfer', 'bank_transfer', 'cash']);
      await db.query(`INSERT INTO payments (tenant_id, invoice_id, customer_id, receipt_number, amount, currency, method, status, provider, reference, received_at, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'succeeded','manual',$8, now() - ($9 || ' days')::interval, $10)`,
        [tenantId, invoiceId, customerId, await nextNumber(db, 'receipt'), amount, currency, method, `REF${int(100000, 999999)}`, String(daysAgo), users.accountant]);
      await recomputeInvoice(db, null, invoiceId);
    }
    for (const j of jobs.filter((x) => x.plan.invoice)) {
      const parts = await db.many(`SELECT description, quantity, unit_price FROM work_order_parts WHERE work_order_id = $1`, [j.id]);
      const labour = await db.many(`SELECT description, hours, rate FROM work_order_labour WHERE work_order_id = $1`, [j.id]);
      const daysAgo = j.plan.invoice === 'overdue' ? Math.max(20, -j.plan.day) : Math.max(1, -j.plan.day - 1);
      const inv = await seedInvoice(j.cust, [...labour.map((l: any) => ({ type: 'labour', desc: l.description, qty: Number(l.hours), price: Number(l.rate) })),
        ...parts.map((x: any) => ({ type: 'part', desc: x.description, qty: Number(x.quantity), price: Number(x.unit_price) }))], daysAgo, { workOrderId: j.id });
      if (j.plan.invoice === 'paid') await pay(inv.id, j.cust.id, inv.total, Math.max(0, daysAgo - int(0, 6)));
      if (j.plan.invoice === 'partial') await pay(inv.id, j.cust.id, Math.round(inv.total * 0.5), Math.max(0, daysAgo - 1));
    }

    // 2 maintenance contracts (one paid)
    const servCat = cats.find((c) => /servic|maintenance|cleaning|inspection/i.test(c.name)) ?? cats[0];
    for (const [k, d] of [{ ci: 0, months: -5, freq: 'quarterly', value: Math.round(Number(servCat.default_price ?? 100) * 3.5), paid: true }, { ci: 10, months: -1, freq: 'half_yearly', value: Math.round(Number(servCat.default_price ?? 100) * 1.8), paid: false }].entries()) {
      const c = customers[d.ci];
      const s = new Date(); s.setUTCMonth(s.getUTCMonth() + d.months); s.setUTCDate(1);
      const e = new Date(s); e.setUTCFullYear(e.getUTCFullYear() + 1); e.setUTCDate(e.getUTCDate() - 1);
      const visits = d.freq === 'quarterly' ? 4 : 2;
      const m = await db.one(`INSERT INTO amc_contracts (tenant_id, branch_id, number, customer_id, address_id, service_category_id, title, start_date, end_date, frequency, visits_included, contract_value,
          currency, coverage, exclusions, status, auto_renew, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active',$16,$17) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'amc'), c.id, c.addressId, servCat.id, k === 0 ? 'Annual maintenance plan' : 'Preventive maintenance — business premises',
          s.toISOString().slice(0, 10), e.toISOString().slice(0, 10), d.freq, visits, d.value, currency, 'Scheduled preventive visits, inspection and minor adjustments.', 'Spare parts and physical damage.', k === 0, users.owner]);
      for (const a of assets.filter((x) => x.ci === d.ci).slice(0, 2)) await db.query(`INSERT INTO amc_contract_assets (tenant_id, contract_id, asset_id) VALUES ($1,$2,$3)`, [tenantId, m.id, a.id]);
      await generateVisits(db, m.id);
      await db.query(`UPDATE scheduled_visits SET status = 'completed', completed_at = due_date::timestamptz + interval '10 hours' WHERE contract_id = $1 AND due_date < current_date - 3`, [m.id]);
      const inv = await seedInvoice(c, [{ type: 'amc', desc: `Maintenance contract (${visits} visits)`, qty: 1, price: d.value }], Math.max(1, -d.months * 30), { amcId: m.id });
      if (d.paid) await pay(inv.id, c.id, inv.total, Math.max(1, -d.months * 30 - 4));
      await db.query(`UPDATE amc_contracts SET payment_status = $2 WHERE id = $1`, [m.id, d.paid ? 'paid' : 'unpaid']);
    }

    // 6 quotations in different states
    const qStates = ['draft', 'sent', 'viewed', 'approved', 'rejected', 'sent'];
    for (let k = 0; k < qStates.length; k++) {
      const c = customers[12 + k * 2];
      const big = cats.reduce((a, b) => (Number(b.default_price ?? 0) > Number(a.default_price ?? 0) ? b : a), cats[0]);
      const lines = [{ type: 'labour', desc: big.name, qty: 1, price: Number(big.default_price ?? 100) }, { type: 'part', desc: p.parts[k % p.parts.length][0], qty: 2, price: p.parts[k % p.parts.length][1] }];
      const calc = lines.map((l) => ({ ...l, ...calcLine({ quantity: l.qty, unitPrice: l.price, taxRate, taxComponents: tax.components }) }));
      const tot = calcTotals(calc);
      const qs = qStates[k]; const daysAgo = int(2, 25);
      const q = await db.one(`INSERT INTO quotations (tenant_id, branch_id, number, customer_id, title, status, currency, issue_date, valid_until, subtotal, discount_total, tax_total, total, tax_breakdown,
          terms, sent_at, approved_at, approved_by_name, rejected_at, rejection_reason, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,'draft',$6, current_date - $7::int, current_date - $7::int + 30, $8,$9,$10,$11,$12,'Prices valid for 30 days.',
          CASE WHEN $13 <> 'draft' THEN now() - ($7 || ' days')::interval END, CASE WHEN $13 = 'approved' THEN now() - ($7 || ' days')::interval + interval '1 day' END,
          CASE WHEN $13 = 'approved' THEN $14 END, CASE WHEN $13 = 'rejected' THEN now() - ($7 || ' days')::interval + interval '2 days' END,
          CASE WHEN $13 = 'rejected' THEN 'Went with another quote' END, $15, now() - ($7 || ' days')::interval) RETURNING id`,
        [tenantId, branchId, await nextNumber(db, 'quotation'), c.id, `${big.name} — proposal`, currency, daysAgo, tot.subtotal, tot.discount_total, tot.tax_total, tot.total,
          JSON.stringify(tot.tax_breakdown), qs, c.name, users.owner]);
      await db.query(`UPDATE quotations SET root_quotation_id = id WHERE id = $1`, [q.id]);
      let pos = 0;
      for (const l of calc) await db.query(`INSERT INTO quotation_items (tenant_id, quotation_id, position, item_type, description, quantity, unit_price, tax_rate_id, tax_rate, tax_components,
          line_subtotal, line_discount, line_tax, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [tenantId, q.id, pos++, l.type, l.desc, l.qty, l.price, tax.id, tax.rate, JSON.stringify(l.tax_components), l.line_subtotal, l.line_discount, l.line_tax, l.line_total]);
      if (qs !== 'draft') await db.query(`UPDATE quotations SET status = $2 WHERE id = $1`, [q.id, qs]);
    }

    // 3 open service requests
    for (let k = 0; k < 3; k++) {
      const c = customers[22 + k];
      await db.query(`INSERT INTO service_requests (tenant_id, branch_id, number, customer_id, address_id, contact_name, contact_phone, description, priority, source, status, preferred_date, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, current_date + $12::int, now() - ($13 || ' hours')::interval)`,
        [tenantId, branchId, await nextNumber(db, 'request'), c.id, c.addressId, c.name, p.phone(22 + k), p.problems[(k + 3) % p.problems.length], k === 0 ? 'high' : 'normal',
          ['portal', 'phone', 'whatsapp'][k], ['new', 'under_review', 'new'][k], k + 1, String(3 + k * 7)]);
    }
    await db.query(`INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, created_at) VALUES ($1,$2,$3,'showcase.seeded','tenant', now())`, [tenantId, users.owner, `owner@${domain}`]);
  });
  logger.info({ slug: p.slug, tenantId }, 'showcase company seeded');
  return tenantId;
}

export async function seedShowcase() {
  await withSystem(bootstrapReferenceData);
  const ids: string[] = [];
  for (let i = 0; i < SHOWCASE.length; i++) ids.push(await seedCompany(SHOWCASE[i], i));
  return ids;
}
