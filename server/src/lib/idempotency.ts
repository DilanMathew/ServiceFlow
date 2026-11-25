/**
 * Idempotent replays for mutating requests that carry an `Idempotency-Key` header.
 * The technician app sends one per queued offline action; if the connection drops after the
 * server committed but before the phone saw the response, the replay returns the stored
 * response instead of applying the action twice. Keys are scoped to (tenant, user) and kept 7 days.
 */
import type { NextFunction, Request, Response } from 'express';
import { withTenant } from '../db/pool.js';
import { AppError } from './errors.js';
import { logger } from '../logger.js';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes with their own domain-level idempotency (payments, refunds) keep their contract. */
const OWN_HANDLING = /^\/api\/app\/payments(\/|$)/;

export function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.get('Idempotency-Key');
  if (!key || !MUTATING.has(req.method) || !req.auth?.tenantId || OWN_HANDLING.test(req.originalUrl)) return next();
  if (!KEY.test(key)) return next(new AppError(400, 'BAD_REQUEST', 'Invalid Idempotency-Key header'));
  const { tenantId, userId } = req.auth;
  const path = req.originalUrl.split('?')[0];

  withTenant(tenantId, (db) => db.maybeOne(`SELECT method, path, status, response FROM idempotent_requests WHERE user_id = $1 AND key = $2`, [userId, key]))
    .then((prior) => {
      if (prior) {
        if (prior.method !== req.method || prior.path !== path) throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        res.setHeader('Idempotent-Replay', 'true');
        return void res.status(prior.status).json(prior.response);
      }
      // Capture the response body once the route answers, and store it for successful or client-error outcomes.
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        const status = res.statusCode;
        if (status < 500 && status !== 401 && status !== 429) {
          withTenant(tenantId, (db) => db.query(
            `INSERT INTO idempotent_requests (tenant_id, user_id, key, method, path, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [tenantId, userId, key, req.method, path, status, body ?? null]))
            .catch((err) => logger.warn({ err }, 'could not store idempotent response'));
        }
        return json(body);
      };
      next();
    })
    .catch(next);
}
