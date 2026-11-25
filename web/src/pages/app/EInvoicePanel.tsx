import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileCode2, Send, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, openFile, post } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { dateTime } from '@/lib/format';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Select, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';

const SCHEME_LABEL: Record<string, string> = { IN_IRN: 'GST e-invoice (IRN)', PEPPOL_BIS3: 'Peppol BIS 3.0', XRECHNUNG: 'XRechnung 3.0' };
const CANCEL_REASONS = [['1', 'Duplicate'], ['2', 'Data entry mistake'], ['3', 'Order cancelled'], ['4', 'Other']];

function Issues({ list }: { list?: { field: string; message: string }[] }) {
  if (!list?.length) return <p className="flex items-center gap-1.5 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" />Ready</p>;
  return <ul className="space-y-1 text-xs text-amber-800">{list.map((x) => <li key={x.field + x.message} className="flex gap-1.5"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{x.message}</li>)}</ul>;
}

/** E-invoicing status and actions for one issued invoice (and its credit notes). */
export function EInvoicePanel({ invoice }: { invoice: any }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, refetch } = useData<any>(['einvoice', invoice.id], invoice.status !== 'draft' ? `/app/einvoice/invoices/${invoice.id}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancel, setCancel] = useState<any>(null);
  if (!data || !data.schemes.length) return null;
  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); refetch(); qc.invalidateQueries({ queryKey: ['invoice', invoice.id] }); }
    catch (e) {
      if (e instanceof ApiError && e.details?.issues) toast.error(e.message, { description: e.details.issues.slice(1, 4).map((x: any) => x.message).join(' · ') || undefined });
      else toastError(e);
    } finally { setBusy(null); }
  };
  const docsFor = (cnId: string | null) => data.documents.filter((d: any) => (d.credit_note_id ?? null) === cnId);
  const india = data.schemes.includes('IN_IRN');
  const targets = [{ id: null as string | null, label: `Invoice ${invoice.number}`, readiness: data.readiness },
    ...data.creditNotes.map((c: any) => ({ id: c.id as string, label: `Credit note ${c.number}`, readiness: c.readiness }))];

  return (
    <Card>
      <CardHeader title="E-invoicing" description={india ? 'Register B2B invoices with the GST Invoice Registration Portal.' : 'EN 16931 structured invoices for Peppol and German public-sector buyers.'} />
      <CardBody className="space-y-4 text-sm">
        {india && !data.providers.einvoice && <Alert tone="amber" title="No e-invoice provider">{can('integrations.manage') ? <>Set one up under <Link className="font-medium underline" to="/app/integrations">Integrations</Link>.</> : 'Ask an administrator to set one up.'}</Alert>}
        {india && data.providers.einvoice?.provider === 'in_sandbox' && <Alert tone="blue" title="Sandbox mode">IRNs are generated for testing only and are not registered with the IRP.</Alert>}
        {targets.map((t) => {
          const docs = docsFor(t.id);
          const active = docs.find((d: any) => d.status === 'registered' || d.status === 'sent');
          return (
            <div key={t.id ?? 'inv'} className="space-y-2 rounded-lg border border-slate-200 p-3">
              <p className="font-medium text-slate-800">{t.label}</p>
              {data.schemes.map((s: string) => {
                const doc = docs.find((d: any) => d.scheme === s && (d.status === 'registered' || d.status === 'sent'));
                const variant = s === 'XRECHNUNG' ? 'xrechnung' : 'peppol';
                const q = `variant=${variant}${t.id ? `&creditNoteId=${t.id}` : ''}`;
                return (
                  <div key={s} className="space-y-1.5 border-t border-slate-100 pt-2 first-of-type:border-0 first-of-type:pt-0">
                    <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{SCHEME_LABEL[s]}</span>
                      {doc && <Badge tone={doc.mode === 'test' ? 'blue' : 'green'}>{doc.status === 'sent' ? 'Sent' : 'Registered'}{doc.mode === 'test' ? ' · test' : ''}</Badge>}</div>
                    {doc?.irn ? <div className="space-y-0.5 text-xs text-slate-600"><p className="break-all font-mono">IRN {doc.irn}</p><p>Ack {doc.ack_no} · {dateTime(doc.ack_date)}</p></div>
                      : doc ? <p className="text-xs text-slate-600">Sent {dateTime(doc.created_at)}{doc.provider_ref ? ` · ref ${doc.provider_ref}` : ''}</p>
                      : <Issues list={t.readiness?.[s]} />}
                    <div className="flex flex-wrap gap-1.5">
                      {s === 'IN_IRN' && !doc && can('invoices.manage') && <Button size="sm" loading={busy === `irn${t.id}`} disabled={!!t.readiness?.[s]?.length || !data.providers.einvoice}
                        onClick={() => run(`irn${t.id}`, () => post(`/app/einvoice/invoices/${invoice.id}/irn`, t.id ? { creditNoteId: t.id } : {}), 'IRN generated')}><ShieldCheck />Generate IRN</Button>}
                      {s === 'IN_IRN' && doc && can('invoices.cancel') && Date.now() - new Date(doc.ack_date).getTime() < 24 * 3600_000 &&
                        <Button size="sm" variant="ghost" onClick={() => setCancel({ doc, reasonCode: '2', remark: '' })}><XCircle />Cancel IRN</Button>}
                      {s !== 'IN_IRN' && <Button size="sm" variant="outline" disabled={!!t.readiness?.[s]?.length}
                        onClick={() => openFile(`/app/einvoice/invoices/${invoice.id}/ubl?${q}`, `${t.label.split(' ').pop()}-${variant}.xml`).catch(toastError)}><FileCode2 />Download XML</Button>}
                      {s !== 'IN_IRN' && !doc && data.providers.peppol && can('invoices.manage') && <Button size="sm" loading={busy === `pp${s}${t.id}`} disabled={!!t.readiness?.[s]?.length}
                        onClick={() => run(`pp${s}${t.id}`, () => post(`/app/einvoice/invoices/${invoice.id}/peppol`, { variant, ...(t.id ? { creditNoteId: t.id } : {}) }), 'Sent via Peppol')}><Send />Send via Peppol</Button>}
                    </div>
                  </div>
                );
              })}
              {!active && docs.some((d: any) => d.status === 'failed') && <p className="text-xs text-red-700">Last attempt failed: {docs.find((d: any) => d.status === 'failed').error}</p>}
            </div>
          );
        })}
      </CardBody>
      <Dialog open={!!cancel} onOpenChange={(o) => !o && setCancel(null)} title="Cancel IRN" description="Allowed by the IRP within 24 hours of registration. After that, issue a credit note."
        footer={<Button variant="danger" loading={busy === 'cancel'} disabled={!cancel || cancel.remark.trim().length < 3}
          onClick={() => run('cancel', () => post(`/app/einvoice/documents/${cancel.doc.id}/cancel`, { reasonCode: cancel.reasonCode, remark: cancel.remark }).then(() => setCancel(null)), 'IRN cancelled')}>Cancel IRN</Button>}>
        {cancel && <div className="space-y-3">
          <Field label="Reason"><Select value={cancel.reasonCode} onChange={(e) => setCancel({ ...cancel, reasonCode: e.target.value })}>{CANCEL_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Remark"><Textarea rows={2} maxLength={100} value={cancel.remark} onChange={(e) => setCancel({ ...cancel, remark: e.target.value })} /></Field></div>}
      </Dialog>
    </Card>
  );
}
