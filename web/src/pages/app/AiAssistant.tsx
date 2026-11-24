import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Lightbulb, Sparkles, TrendingUp, TriangleAlert, Users } from 'lucide-react';
import { post } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ErrorState, Field, PageHeader, PageLoader, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';

const ICON: Record<string, any> = { trend: TrendingUp, risk: TriangleAlert, opportunity: Lightbulb, workload: Users };
export default function AiAssistant() {
  const { data: status } = useData<any>(['ai-status'], '/app/ai/status');
  const { data: ins, isLoading, error, refetch, isFetching } = useData<any>(['ai-insights'], '/app/ai/insights');
  const [text, setText] = useState('My AC is leaking water and making noise.');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <PageHeader title="AI assistant" description="AI suggests; people decide. Nothing is assigned, cancelled or charged automatically."
        actions={status && <Badge tone={status.provider === 'rules' ? 'slate' : 'violet'}>{status.provider === 'rules' ? 'Rules engine (no external AI)' : 'Claude'} · {status.usedThisMonth}/{status.quota} AI requests this month</Badge>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardHeader title="Business insights" description="From aggregated figures only — no customer personal data is sent." actions={<Button size="sm" variant="outline" loading={isFetching} onClick={() => refetch()}>Refresh</Button>} />
          <CardBody>{error ? <ErrorState error={error} /> : isLoading ? <PageLoader /> : <ul className="space-y-3">{ins.insights.map((i: any, k: number) => { const I = ICON[i.type] ?? Sparkles; return (
            <li key={k} className="flex gap-3 rounded-lg border border-slate-200 p-3"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-violet-600"><I className="h-4 w-4" /></div>
              <div><p className="text-sm font-semibold text-navy-900">{i.title}</p><p className="text-sm text-slate-600">{i.detail}</p></div></li>); })}</ul>}</CardBody></Card>
        <Card><CardHeader title="Interpret a service request" description="Paste what the customer said. The result is a suggestion to confirm." />
          <CardBody className="space-y-3"><Field label="Customer message"><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            <Button loading={busy} onClick={async () => { setBusy(true); try { setRes((await post('/app/ai/interpret', { text })).data); } catch (e) { toastError(e); } finally { setBusy(false); } }}><Sparkles />Interpret</Button>
            {res && <Alert tone="blue" title={res.summary}><ul className="mt-1 space-y-0.5 text-xs"><li>Suggested category: <b>{res.serviceCategory ?? 'unclear'}</b></li><li>Equipment: <b>{res.equipmentType ?? '—'}</b></li>
              <li>Priority: <b>{res.priority}</b> — {res.priorityReason}</li>{res.missingInformation?.length > 0 && <li>Ask for: {res.missingInformation.join('; ')}</li>}</ul>
              <Link to="/app/requests" className="mt-2 inline-block text-xs font-medium text-brand-700">Create a request with this →</Link></Alert>}
          </CardBody></Card>
        <Card className="lg:col-span-2"><CardHeader title="Where else AI helps" /><CardBody className="grid gap-4 text-sm text-slate-600 sm:grid-cols-3">
          <p><b className="text-navy-900">Service reports.</b> On a work order's Service report tab, technicians turn rough notes into a professional report they can edit before saving.</p>
          <p><b className="text-navy-900">Scheduling.</b> Dispatch suggestions rank technicians by skill, area, availability, workload and travel. A dispatcher always confirms.</p>
          <p><b className="text-navy-900">Customer assistant.</b> In the customer portal, customers ask about their own jobs and invoices. Actions like cancelling or paying need their confirmation.</p>
        </CardBody></Card>
      </div>
      <p className="mt-4 flex items-center gap-1 text-xs text-slate-400"><Bot className="h-3.5 w-3.5" />Every AI request is logged with its feature, provider and token usage, and counted against your plan's monthly quota.</p>
    </div>
  );
}
