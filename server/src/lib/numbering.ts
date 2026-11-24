import type { Db } from '../db/pool.js';

export type CounterKey = 'job' | 'invoice' | 'quotation' | 'request' | 'amc' | 'customer' | 'asset' | 'ticket' | 'credit_note' | 'receipt';
const prefixCol: Record<CounterKey, string | null> = {
  job: 'job_number_prefix', invoice: 'invoice_number_prefix', quotation: 'quotation_number_prefix',
  request: 'request_number_prefix', amc: 'amc_number_prefix', customer: 'customer_number_prefix',
  asset: 'asset_number_prefix', ticket: 'ticket_number_prefix', credit_note: 'credit_note_prefix', receipt: null,
};

/**
 * Gapless, concurrency-safe document numbers. The UPSERT takes a row lock on the counter, so two
 * concurrent transactions can never receive the same number; the number is consumed only if the
 * surrounding transaction commits.
 */
export async function nextNumber(db: Db, key: CounterKey): Promise<string> {
  const r = await db.one<{ value: number }>(
    `INSERT INTO tenant_counters (tenant_id, counter, value) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, counter) DO UPDATE SET value = tenant_counters.value + 1 RETURNING value`,
    [db.tenantId, key],
  );
  const col = prefixCol[key];
  let prefix = 'RCPT-';
  if (col) {
    const s = await db.maybeOne(`SELECT ${col} AS p FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
    prefix = s?.p ?? '';
  }
  const pad = key === 'invoice' || key === 'credit_note' ? 5 : 6;
  return `${prefix}${String(r.value).padStart(pad, '0')}`;
}
