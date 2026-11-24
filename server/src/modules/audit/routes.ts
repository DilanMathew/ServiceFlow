import { Router } from 'express';
import { z } from 'zod';
import { ah, listQuery, paged, parse, Where } from '../../lib/http.js';
import { tx } from '../common.js';

export const auditRouter = Router();

/** Read-only. audit_logs is append-only at the database level (trigger + revoked privileges). */
auditRouter.get('/', ah(async (req, res) => {
  const q = parse(listQuery.extend({ action: z.string().optional(), entityType: z.string().optional(), entityId: z.string().optional(), userId: z.string().uuid().optional(),
    from: z.string().optional(), to: z.string().optional() }), req.query);
  const w = new Where();
  w.add('a.tenant_id = current_tenant_id()');
  if (q.action) w.add('a.action ILIKE ?', `${q.action}%`);
  w.addIf(q.entityType, 'a.entity_type = ?', q.entityType); w.addIf(q.entityId, 'a.entity_id = ?', q.entityId); w.addIf(q.userId, 'a.user_id = ?', q.userId);
  w.addIf(q.from, 'a.created_at >= ?', q.from); w.addIf(q.to, 'a.created_at < ?', q.to);
  if (q.q) w.add('(a.action ILIKE ? OR a.user_email ILIKE ? OR a.entity_id ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const rows = await tx(req, (db) => db.many(`SELECT a.*, count(*) OVER() AS _total FROM audit_logs a ${w.sql} ORDER BY a.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));
