import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../../lib/http.js';
import { tx, can } from '../common.js';

export const searchRouter = Router();

/** Global quick search across modules the user is allowed to see. */
searchRouter.get('/', ah(async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const like = `%${q.q}%`;
  const data = await tx(req, async (db) => {
    const out: { type: string; id: string; title: string; subtitle: string | null; link: string }[] = [];
    if (can(req, 'customers.read')) for (const r of await db.many(`SELECT id, number, full_name, phone FROM customers WHERE archived_at IS NULL AND (full_name ILIKE $1 OR number ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1) LIMIT 5`, [like]))
      out.push({ type: 'customer', id: r.id, title: r.full_name, subtitle: `${r.number}${r.phone ? ` · ${r.phone}` : ''}`, link: `/app/customers/${r.id}` });
    if (can(req, 'work_orders.read')) for (const r of await db.many(`SELECT w.id, w.number, w.title, w.status FROM work_orders w WHERE w.number ILIKE $1 OR w.title ILIKE $1 LIMIT 5`, [like]))
      out.push({ type: 'work_order', id: r.id, title: `${r.number} — ${r.title}`, subtitle: r.status, link: `/app/work-orders/${r.id}` });
    if (can(req, 'requests.read')) for (const r of await db.many(`SELECT id, number, contact_name, status FROM service_requests WHERE number ILIKE $1 OR contact_name ILIKE $1 LIMIT 5`, [like]))
      out.push({ type: 'request', id: r.id, title: `${r.number} — ${r.contact_name}`, subtitle: r.status, link: `/app/requests/${r.id}` });
    if (can(req, 'invoices.read')) for (const r of await db.many(`SELECT id, number, status FROM invoices WHERE number ILIKE $1 LIMIT 5`, [like]))
      out.push({ type: 'invoice', id: r.id, title: r.number, subtitle: r.status, link: `/app/invoices/${r.id}` });
    if (can(req, 'quotations.read')) for (const r of await db.many(`SELECT id, number, revision, status FROM quotations WHERE number ILIKE $1 AND status <> 'superseded' LIMIT 5`, [like]))
      out.push({ type: 'quotation', id: r.id, title: r.number, subtitle: r.status, link: `/app/quotations/${r.id}` });
    if (can(req, 'assets.read')) for (const r of await db.many(`SELECT id, number, name, serial_number FROM assets WHERE number ILIKE $1 OR name ILIKE $1 OR serial_number ILIKE $1 LIMIT 5`, [like]))
      out.push({ type: 'asset', id: r.id, title: `${r.number} — ${r.name}`, subtitle: r.serial_number, link: `/app/assets/${r.id}` });
    return out;
  });
  res.json({ data });
}));
