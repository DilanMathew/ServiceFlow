import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Button, Card, CardBody, Checkbox, Field, Input, Select, Textarea } from '@/components/ui';
import { toastError } from '@/components/form';
import { Logo } from '@/components/layout/Logo';
import { COUNTRIES } from '../auth/Register';

const STEPS = ['Business details', 'Region & tax', 'Services', 'Hours & areas', 'Finish'];
const PRESET_LABEL: Record<string, string> = { hvac: 'Air-conditioning (HVAC)', electrical: 'Electrical', plumbing: 'Plumbing', appliance: 'Appliance repair', cctv: 'CCTV & security', solar: 'Solar', generator: 'Generators & equipment', general: 'General field service' };

export default function Onboarding() {
  const nav = useNavigate();
  const { me, reload } = useAuth();
  const { data: presets } = useData<any[]>(['presets'], '/app/settings/onboarding/presets');
  const { data: s } = useData<any>(['settings-lists'], '/app/settings');
  const [step, setStep] = useState(Math.min(me?.settings?.onboarding_step ?? 0, 4));
  const [busy, setBusy] = useState(false);
  const [biz, setBiz] = useState<any>(null);
  const [region, setRegion] = useState<any>(null);
  const [preset, setPreset] = useState('hvac');
  const [extra, setExtra] = useState('');
  const [hours, setHours] = useState({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] });
  const [areas, setAreas] = useState('');
  const [sample, setSample] = useState(true);
  if (s && !biz) {
    const st = s.settings;
    setBiz({ name: st.business_name, legalName: st.legal_name ?? '', phone: st.business_phone ?? '', email: st.business_email ?? '', addressLine1: st.address_line1 ?? '', city: st.city ?? '', state: st.state ?? '', postalCode: st.postal_code ?? '', country: st.country, employeeCount: '', technicianCount: '' });
    setRegion({ currency: st.currency, timezone: st.timezone, taxRegistrationNumber: st.tax_registration_number ?? '', taxRegistrationLabel: st.tax_registration_label, invoiceNumberPrefix: st.invoice_number_prefix, quotationNumberPrefix: st.quotation_number_prefix });
  }
  const run = async (fn: () => Promise<void>, next = step + 1) => { setBusy(true); try { await fn(); setStep(next); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const f = (o: any, set: (x: any) => void, k: string) => ({ value: o?.[k] ?? '', onChange: (e: any) => set({ ...o, [k]: e.target.value }) });
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4"><Logo /><button className="text-sm text-slate-500 hover:text-slate-800" onClick={() => nav('/app')}>Skip for now</button></div></header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <ol className="mb-8 flex flex-wrap gap-2">{STEPS.map((t, i) => <li key={t} className={cn('flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium', i < step ? 'bg-emerald-50 text-emerald-700' : i === step ? 'bg-brand-600 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200')}>
          {i < step ? <Check className="h-3.5 w-3.5" /> : <span>{i + 1}</span>}{t}</li>)}</ol>
        <Card><CardBody className="space-y-5 p-6">
          {step === 0 && biz && <><h1 className="text-xl font-semibold text-navy-900">Tell us about your business</h1>
            <div className="grid gap-4 sm:grid-cols-2"><Field label="Business name"><Input {...f(biz, setBiz, 'name')} /></Field><Field label="Legal name"><Input {...f(biz, setBiz, 'legalName')} /></Field>
              <Field label="Business email"><Input type="email" {...f(biz, setBiz, 'email')} /></Field><Field label="Phone"><Input {...f(biz, setBiz, 'phone')} /></Field>
              <Field label="Address" className="sm:col-span-2"><Input {...f(biz, setBiz, 'addressLine1')} /></Field><Field label="City"><Input {...f(biz, setBiz, 'city')} /></Field><Field label="State / region"><Input {...f(biz, setBiz, 'state')} /></Field>
              <Field label="Postal code"><Input {...f(biz, setBiz, 'postalCode')} /></Field><Field label="Country"><Select {...f(biz, setBiz, 'country')} options={COUNTRIES} /></Field>
              <Field label="Employees"><Input type="number" min={0} {...f(biz, setBiz, 'employeeCount')} /></Field><Field label="Technicians"><Input type="number" min={0} {...f(biz, setBiz, 'technicianCount')} /></Field></div>
            <Button loading={busy} onClick={() => run(async () => { await patch('/app/settings/profile', { ...biz, employeeCount: biz.employeeCount ? Number(biz.employeeCount) : null, technicianCount: biz.technicianCount ? Number(biz.technicianCount) : null, businessCategory: preset }); await post('/app/settings/onboarding', { step: 1 }); })}>Continue</Button></>}
          {step === 1 && region && <><h1 className="text-xl font-semibold text-navy-900">Region, currency & tax</h1><p className="text-sm text-slate-500">We pre-filled these from your country. Tax rates can be adjusted later in Settings.</p>
            <div className="grid gap-4 sm:grid-cols-2"><Field label="Currency"><Input {...f(region, setRegion, 'currency')} /></Field><Field label="Time zone"><Input {...f(region, setRegion, 'timezone')} /></Field>
              <Field label={`${region.taxRegistrationLabel} (optional)`}><Input {...f(region, setRegion, 'taxRegistrationNumber')} /></Field><Field label="Tax ID label"><Input {...f(region, setRegion, 'taxRegistrationLabel')} /></Field>
              <Field label="Invoice number prefix"><Input {...f(region, setRegion, 'invoiceNumberPrefix')} /></Field><Field label="Quotation number prefix"><Input {...f(region, setRegion, 'quotationNumberPrefix')} /></Field></div>
            <p className="text-xs text-slate-500">Tax rates set up: {(s?.taxRates ?? []).map((t: any) => t.name).join(', ')}</p>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep(0)}>Back</Button><Button loading={busy} onClick={() => run(async () => { await patch('/app/settings', { ...region, currency: region.currency.toUpperCase(), taxRegistrationNumber: region.taxRegistrationNumber || null }); await post('/app/settings/onboarding', { step: 2 }); })}>Continue</Button></div></>}
          {step === 2 && <><h1 className="text-xl font-semibold text-navy-900">What services do you offer?</h1>
            <div className="grid gap-3 sm:grid-cols-2">{(presets ?? []).map((p) => <button key={p.key} type="button" onClick={() => setPreset(p.key)} className={cn('rounded-lg border p-3 text-left text-sm', preset === p.key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:border-slate-300')}>
              <p className="font-medium text-navy-900">{PRESET_LABEL[p.key] ?? p.key}</p><p className="mt-0.5 text-xs text-slate-500">{p.services.join(', ')}</p></button>)}</div>
            <Field label="Additional service categories" hint="Comma separated"><Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. Duct cleaning, Thermostat installation" /></Field>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep(1)}>Back</Button><Button loading={busy} onClick={() => run(() => post('/app/settings/onboarding', { step: 3, preset, serviceCategories: extra.split(',').map((x) => x.trim()).filter((x) => x.length > 1) }))}>Continue</Button></div></>}
          {step === 3 && <><h1 className="text-xl font-semibold text-navy-900">Working hours & service areas</h1>
            <div className="grid gap-4 sm:grid-cols-2"><Field label="Day starts"><Input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></Field><Field label="Day ends"><Input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></Field></div>
            <div className="flex flex-wrap gap-3">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => <Checkbox key={d} label={d} checked={hours.days.includes(i + 1)} onChange={(e) => setHours({ ...hours, days: e.target.checked ? [...hours.days, i + 1] : hours.days.filter((x) => x !== i + 1) })} />)}</div>
            <Field label="Service areas" hint="One per line: Area name: postal codes (comma separated)"><Textarea rows={4} value={areas} onChange={(e) => setAreas(e.target.value)} placeholder={'Koramangala: 560034, 560095\nWhitefield: 560066'} /></Field>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep(2)}>Back</Button><Button loading={busy} onClick={() => run(async () => {
              await patch('/app/settings', { workingHoursStart: hours.start, workingHoursEnd: hours.end, workingDays: hours.days });
              await post('/app/settings/onboarding', { step: 4, serviceAreas: areas.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, codes] = l.split(':'); return { name: name.trim(), postalCodes: (codes ?? '').split(',').map((c) => c.trim()).filter(Boolean) }; }) });
            })}>Continue</Button></div></>}
          {step === 4 && <><h1 className="text-xl font-semibold text-navy-900">You're ready to go</h1>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600"><li>Invite your team from Settings → Users & roles, and add technicians.</li><li>Share your public request form: <b>{location.origin}/r/{me?.tenant?.slug}</b></li>
              <li>Customers can use the portal: <b>{location.origin}/portal/{me?.tenant?.slug}/login</b></li><li>Connect email, WhatsApp and payments in Integrations.</li></ul>
            <Checkbox label="Add a few clearly-labelled sample customers and jobs so I can explore" checked={sample} onChange={(e) => setSample(e.target.checked)} />
            <Button loading={busy} onClick={() => run(async () => { await post('/app/settings/onboarding', { step: 5, complete: true, sampleData: sample }); await reload(); toast.success('Setup complete'); nav('/app'); }, 4)}>Go to dashboard</Button></>}
        </CardBody></Card>
      </main>
    </div>
  );
}
