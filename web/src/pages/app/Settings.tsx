import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { del, openFile, patch, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useData, useListState, usePaged } from '@/lib/hooks';
import { date, dateTime } from '@/lib/format';
import { titleCase } from '@/lib/utils';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DataTable, Dialog, EmptyState, Field, Input, PageHeader, PageLoader, Select, StatusBadge, Tabs, Textarea, useConfirm } from '@/components/ui';
import { FormDialog, FormFields, applyServerErrors, cleanValues, toastError, type FieldDef } from '@/components/form';
import { CustomerPicker, useSettingsLists } from './shared';
import { COUNTRIES } from '../auth/Register';

const EVENTS = ['request.created', 'request.approved', 'job.assigned', 'job.dispatched', 'job.reminder', 'job.rescheduled', 'job.completed', 'quotation.sent', 'quotation.approved',
  'invoice.issued', 'payment.received', 'payment.failed', 'amc.visit_upcoming', 'amc.expiring'];

function SaveForm({ fields, defaults, onSubmit, cols = 2 }: { fields: FieldDef[]; defaults: any; onSubmit: (v: any) => Promise<any>; cols?: 1 | 2 }) {
  const form = useForm({ defaultValues: defaults });
  useEffect(() => form.reset(defaults), [JSON.stringify(defaults)]); // eslint-disable-line
  const submit = form.handleSubmit(async (v) => { try { await onSubmit(cleanValues(fields, v)); toast.success('Saved'); } catch (e) { if (!applyServerErrors(form, e, fields.map((f) => f.name))) toastError(e); } });
  return <form onSubmit={submit} noValidate><FormFields fields={fields} form={form as any} cols={cols} /><div className="mt-5 flex justify-end"><Button type="submit" loading={form.formState.isSubmitting}>Save changes</Button></div></form>;
}

function SimpleList({ title, rows, columns, fields, path, toDefaults, description }: { title: string; rows: any[]; columns: any[]; fields: FieldDef[]; path: string; toDefaults: (r: any) => any; description?: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['settings-lists'] });
  return (
    <Card><CardHeader title={title} description={description} actions={<Button size="sm" variant="outline" onClick={() => setEdit({})}><Plus />Add</Button>} />
      <DataTable rows={rows} onRowClick={(r: any) => setEdit(r)} empty={<EmptyState title={`No ${title.toLowerCase()}`} />} columns={[...columns,
        { key: 'x', header: '', cell: (r: any) => <Button size="icon-sm" variant="ghost" aria-label="Delete" onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: 'Delete?', description: 'Records in use are deactivated instead.', danger: true, confirmLabel: 'Delete' })) del(`/app/settings/${path}/${r.id}`).then(refresh).catch(toastError); }}><Trash2 /></Button> }]} />
      <FormDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? `Edit` : `Add`} fields={fields} defaultValues={edit?.id ? toDefaults(edit) : undefined}
        onSubmit={async (v) => {
          if (typeof v.postalCodes === 'string') v.postalCodes = v.postalCodes.split(',').map((x: string) => x.trim()).filter(Boolean);
          if (v.postalCodes === null) v.postalCodes = [];
          edit?.id ? await patch(`/app/settings/${path}/${edit.id}`, v) : await post(`/app/settings/${path}`, v); refresh();
        }} successMessage="Saved" />
    </Card>
  );
}

function UsersRoles() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { feature } = useAuth();
  const { data: users } = useData<any[]>(['users'], '/app/users');
  const { data: rp } = useData<any>(['roles'], '/app/users/roles');
  const { data: s } = useSettingsLists();
  const [invite, setInvite] = useState<any>(null);
  const [role, setRole] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const roleOpts = (rp?.roles ?? []).map((r: any) => ({ value: r.id, label: r.name }));
  const act = (p: Promise<any>, m: string) => p.then(() => { toast.success(m); refresh(); }).catch(toastError);
  return (
    <div className="space-y-6">
      <Card><CardHeader title="Team members" description="Technicians are managed in Technicians." actions={<Button size="sm" onClick={() => setInvite({ email: '', fullName: '', roleId: '', branchId: '' })}><Plus />Invite user</Button>} />
        <DataTable rows={users} empty={<EmptyState title="No users" />} columns={[
          { key: 'n', header: 'User', cell: (u: any) => <div><p className="font-medium">{u.full_name}</p><p className="text-xs text-slate-500">{u.email}</p></div> },
          { key: 'r', header: 'Roles', cell: (u: any) => <div className="flex flex-wrap gap-1">{u.roles.map((r: any) => <Badge key={r.id} tone={r.key === 'owner' ? 'navy' : 'slate'}>{r.name}</Badge>)}</div> },
          { key: 'b', header: 'Branch', hideOnMobile: true, cell: (u: any) => u.branch_name ?? 'All' },
          { key: 'mfa', header: 'MFA', hideOnMobile: true, cell: (u: any) => u.mfa_enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge> },
          { key: 'l', header: 'Last login', hideOnMobile: true, cell: (u: any) => u.last_login_at ? dateTime(u.last_login_at) : '—' },
          { key: 's', header: 'Status', cell: (u: any) => u.invitation_pending ? <Badge tone="amber">Invited</Badge> : <StatusBadge status={u.is_active ? 'active' : 'inactive'} /> },
          { key: 'x', header: '', cell: (u: any) => <div className="flex justify-end gap-1">
            <Select aria-label="Role" className="h-8 w-40 py-1 text-xs" value={u.roles[0]?.id ?? ''} onChange={(e) => act(patch(`/app/users/${u.id}`, { roleIds: [e.target.value] }), 'Role updated')} options={roleOpts} />
            {u.invitation_pending && <Button size="sm" variant="ghost" onClick={() => act(post(`/app/users/${u.id}/resend-invite`), 'Invitation resent')}>Resend</Button>}
            {u.is_active ? <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: `Deactivate ${u.full_name}?`, description: 'They are signed out immediately and cannot sign in.', danger: true, confirmLabel: 'Deactivate' })) act(post(`/app/users/${u.id}/deactivate`), 'User deactivated'); }}>Deactivate</Button>
              : <Button size="sm" variant="ghost" onClick={() => act(post(`/app/users/${u.id}/activate`), 'User activated')}>Activate</Button>}</div> }]} /></Card>
      <Card><CardHeader title="Roles & permissions" description="System roles are fixed. Custom roles are available on plans with advanced permissions."
        actions={feature('advanced_permissions') && <Button size="sm" variant="outline" onClick={() => setRole({ name: '', description: '', permissions: [] })}><Plus />Custom role</Button>} />
        <DataTable rows={rp?.roles} onRowClick={(r: any) => !r.is_system && setRole({ id: r.id, name: r.name, description: r.description ?? '', permissions: r.permissions })} columns={[
          { key: 'n', header: 'Role', cell: (r: any) => <div><p className="font-medium">{r.name} {r.is_system && <Badge>System</Badge>}</p><p className="text-xs text-slate-500">{r.description}</p></div> },
          { key: 'p', header: 'Permissions', cell: (r: any) => <span className="text-xs text-slate-600">{r.permissions.length} permissions</span> }]} /></Card>
      <Dialog open={!!invite} onOpenChange={(o) => !o && setInvite(null)} title="Invite a team member" footer={<Button onClick={() => act(post('/app/users', { email: invite.email, fullName: invite.fullName, roleIds: [invite.roleId], branchId: invite.branchId || null }), 'Invitation sent').then(() => setInvite(null))}>Send invitation</Button>}>
        {invite && <div className="grid gap-3 sm:grid-cols-2"><Field label="Full name"><Input value={invite.fullName} onChange={(e) => setInvite({ ...invite, fullName: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
          <Field label="Role"><Select value={invite.roleId} onChange={(e) => setInvite({ ...invite, roleId: e.target.value })} placeholder="Select…" options={roleOpts.filter((o: any) => o.label !== 'Technician')} /></Field>
          <Field label="Branch" hint="Branch managers only see their branch"><Select value={invite.branchId} onChange={(e) => setInvite({ ...invite, branchId: e.target.value })} placeholder="All branches" options={(s?.branches ?? []).map((b: any) => ({ value: b.id, label: b.name }))} /></Field></div>}
      </Dialog>
      <Dialog open={!!role} onOpenChange={(o) => !o && setRole(null)} title={role?.id ? 'Edit role' : 'New custom role'} size="xl" footer={<Button onClick={() => (role.id ? put(`/app/users/roles/${role.id}`, role) : post('/app/users/roles', role)).then(() => { setRole(null); qc.invalidateQueries({ queryKey: ['roles'] }); toast.success('Role saved'); }).catch(toastError)}>Save role</Button>}>
        {role && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><Input value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} /></Field><Field label="Description"><Input value={role.description} onChange={(e) => setRole({ ...role, description: e.target.value })} /></Field></div>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">{(rp?.permissions ?? []).map((p: any) => <Checkbox key={p.code} label={p.description} hint={p.code} checked={role.permissions.includes(p.code)}
            onChange={(e) => setRole({ ...role, permissions: e.target.checked ? [...role.permissions, p.code] : role.permissions.filter((x: string) => x !== p.code) })} />)}</div></div>}
      </Dialog>
    </div>
  );
}

function AuditLog() {
  const { params, set } = useListState();
  const { data, isLoading, error, refetch } = usePaged<any>('/app/audit-logs', { ...params, tab: undefined });
  const [view, setView] = useState<any>(null);
  return (
    <Card><CardHeader title="Audit log" description="Append-only. Records cannot be edited or deleted by anyone." />
      <div className="flex gap-3 border-b border-slate-100 p-4"><Input className="w-64" placeholder="Filter by action, e.g. invoice." value={params.action ?? ''} onChange={(e) => set({ action: e.target.value })} /></div>
      <DataTable rows={data?.data} loading={isLoading} error={error} onRetry={refetch} meta={data?.meta} onPage={(page) => set({ page }, false)} onRowClick={setView} columns={[
        { key: 't', header: 'Time', cell: (r: any) => dateTime(r.created_at) }, { key: 'a', header: 'Action', cell: (r: any) => <span className="font-mono text-xs">{r.action}</span> },
        { key: 'u', header: 'User', cell: (r: any) => r.user_email ?? 'System' }, { key: 'e', header: 'Record', hideOnMobile: true, cell: (r: any) => r.entity_type ? `${r.entity_type}` : '—' },
        { key: 'ip', header: 'IP / request', hideOnMobile: true, cell: (r: any) => <span className="text-xs text-slate-500">{r.ip ?? ''} {r.request_id?.slice(0, 8)}</span> }]} />
      <Dialog open={!!view} onOpenChange={(o) => !o && setView(null)} title={view?.action ?? ''} size="lg">{view && <div className="grid gap-3 text-xs sm:grid-cols-2">
        <div><p className="mb-1 font-semibold">Before</p><pre className="max-h-80 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(view.before_data, null, 2) ?? '—'}</pre></div>
        <div><p className="mb-1 font-semibold">After</p><pre className="max-h-80 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(view.after_data, null, 2) ?? '—'}</pre></div>
        <p className="sm:col-span-2 text-slate-500">Request {view.request_id} · {view.user_agent}</p></div>}</Dialog>
    </Card>
  );
}

function Privacy() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data } = useData<any[]>(['privacy'], '/app/privacy/requests');
  const [v, setV] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['privacy'] });
  return (
    <Card><CardHeader title="Data subject requests" description="Export, rectification and erasure workflows. Erasure anonymises personal data and keeps records you are legally required to retain (e.g. issued invoices)."
      actions={<Button size="sm" onClick={() => setV({ customerId: '', requestType: 'export', notes: '' })}><Plus />Log request</Button>} />
      <DataTable rows={data} empty={<EmptyState title="No requests" />} columns={[{ key: 'c', header: 'Customer', cell: (r: any) => `${r.customer_name} (${r.customer_number})` },
        { key: 't', header: 'Type', cell: (r: any) => titleCase(r.request_type) }, { key: 'd', header: 'Logged', cell: (r: any) => dateTime(r.created_at) }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.status === 'completed' ? 'completed' : 'pending'} label={titleCase(r.status)} /> },
        { key: 'x', header: '', cell: (r: any) => <div className="flex justify-end gap-1">{r.status === 'pending' && r.request_type !== 'rectification' && <Button size="sm" variant={r.request_type === 'erasure' ? 'danger-outline' : 'outline'} onClick={async () => {
          if (r.request_type === 'erasure' && !(await confirm({ title: 'Erase personal data?', description: 'Name, contact details, addresses and communications are permanently anonymised.', danger: true, confirmLabel: 'Erase' }))) return;
          post(`/app/privacy/requests/${r.id}/complete`).then(() => { toast.success('Completed'); refresh(); }).catch(toastError); }}>{r.request_type === 'export' ? 'Generate export' : 'Erase data'}</Button>}
          {r.result_document_id && <Button size="sm" variant="ghost" onClick={() => openFile(`/app/documents/${r.result_document_id}/download`, 'data-export.json').catch(toastError)}>Download</Button>}</div> }]} />
      <Dialog open={!!v} onOpenChange={(o) => !o && setV(null)} title="Log a data subject request" footer={<Button disabled={!v?.customerId} onClick={() => post('/app/privacy/requests', v).then(() => { setV(null); refresh(); }).catch(toastError)}>Log request</Button>}>
        {v && <div className="space-y-3"><Field label="Customer"><CustomerPicker value={v.customerId} onChange={(id) => setV({ ...v, customerId: id })} /></Field>
          <Field label="Type"><Select value={v.requestType} onChange={(e) => setV({ ...v, requestType: e.target.value })} options={['export', 'rectification', 'erasure'].map((t) => ({ value: t, label: titleCase(t) }))} /></Field>
          <Field label="Notes"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field></div>}
      </Dialog>
    </Card>
  );
}

function SupportAccess() {
  const qc = useQueryClient();
  const { data } = useData<any[]>(['support-access'], '/app/settings/support-access');
  const [v, setV] = useState({ reason: '', hours: 4 });
  return (
    <Card><CardHeader title="NEXUS support access" description="NEXUS staff cannot see your business data unless you grant time-limited, read-only access here. Every access is audited." />
      <CardBody className="space-y-4"><div className="flex flex-wrap items-end gap-3"><Field label="Reason" className="min-w-[260px] flex-1"><Input value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder="e.g. Help configuring invoices" /></Field>
        <Field label="Duration"><Select value={String(v.hours)} onChange={(e) => setV({ ...v, hours: Number(e.target.value) })} options={[1, 4, 24, 72].map((h) => ({ value: String(h), label: `${h} hours` }))} /></Field>
        <Button disabled={v.reason.length < 5} onClick={() => post('/app/settings/support-access', v).then(() => { toast.success('Access granted'); qc.invalidateQueries({ queryKey: ['support-access'] }); setV({ reason: '', hours: 4 }); }).catch(toastError)}>Grant access</Button></div>
        <ul className="divide-y divide-slate-100 text-sm">{(data ?? []).map((g) => { const live = !g.revoked_at && new Date(g.expires_at) > new Date(); return (
          <li key={g.id} className="flex items-center justify-between py-2.5"><span>{g.reason}<span className="block text-xs text-slate-500">by {g.granted_by} · {live ? `expires ${dateTime(g.expires_at)}` : g.revoked_at ? 'revoked' : 'expired'}</span></span>
            {live && <Button size="sm" variant="danger-outline" onClick={() => del(`/app/settings/support-access/${g.id}`).then(() => qc.invalidateQueries({ queryKey: ['support-access'] })).catch(toastError)}>Revoke</Button>}</li>); })}</ul>
      </CardBody></Card>
  );
}

export default function Settings() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'business';
  const qc = useQueryClient();
  const { can, reload, me } = useAuth();
  const { data: s, isLoading } = useSettingsLists();
  const [prefs, setPrefs] = useState<Record<string, any>>({});
  useEffect(() => { if (s) setPrefs(s.settings.notification_preferences ?? {}); }, [s]);
  if (isLoading || !s) return <PageLoader />;
  const st = s.settings;
  const saveSettings = async (v: any) => { await patch('/app/settings', v); qc.invalidateQueries({ queryKey: ['settings-lists'] }); reload(); };
  const tabs = [['business', 'Business'], ['regional', 'Regional & tax'], ['operations', 'Operations'], ['catalog', 'Services & equipment'], ['areas', 'Areas & holidays'], ['branches', 'Branches'],
    ['users', 'Users & roles'], ['notifications', 'Notifications'], ['access', 'Support access'], ['privacy', 'Privacy'], ['audit', 'Audit log']].filter(([k]) => (k === 'users' ? can('users.manage') : k === 'audit' ? can('audit.read') : k === 'privacy' ? can('privacy.manage') : can('settings.manage')));
  return (
    <div>
      <PageHeader title="Settings" description={`${me?.tenant?.name} · workspace ${me?.tenant?.slug}`} />
      <Tabs value={tab} onValueChange={(t) => setSp({ tab: t })} tabs={tabs.map(([value, label]) => ({ value, label }))} />
      <div className="mt-5 space-y-6">
        {tab === 'business' && <Card><CardHeader title="Business profile" description="Shown on invoices, quotations and customer messages." /><CardBody>
          <SaveForm fields={[{ name: 'name', label: 'Business name', required: true }, { name: 'legalName', label: 'Legal name' }, { name: 'email', label: 'Business email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
            { name: 'addressLine1', label: 'Address line 1', span: 2 }, { name: 'addressLine2', label: 'Address line 2', span: 2 }, { name: 'city', label: 'City' }, { name: 'state', label: 'State / region' }, { name: 'postalCode', label: 'Postal code' },
            { name: 'country', label: 'Country', type: 'select', options: COUNTRIES }, { name: 'businessCategory', label: 'Business type' }, { name: 'employeeCount', label: 'Employees', type: 'number' }]}
            defaults={{ name: st.business_name, legalName: st.legal_name ?? '', email: st.business_email ?? '', phone: st.business_phone ?? '', addressLine1: st.address_line1 ?? '', addressLine2: st.address_line2 ?? '', city: st.city ?? '', state: st.state ?? '', postalCode: st.postal_code ?? '', country: st.country, businessCategory: '', employeeCount: '' }}
            onSubmit={async (v) => { await patch('/app/settings/profile', { ...v, country: v.country ?? undefined }); qc.invalidateQueries({ queryKey: ['settings-lists'] }); reload(); }} /></CardBody></Card>}
        {tab === 'regional' && <>
          <Card><CardHeader title="Currency, time zone & tax" description="Tax rules are configurable per business — nothing is hard-coded to one country." /><CardBody>
            <SaveForm fields={[{ name: 'currency', label: 'Currency (ISO code)', hint: 'Cannot change after invoices are issued' }, { name: 'timezone', label: 'Time zone', hint: 'e.g. Asia/Kolkata, Europe/Berlin' }, { name: 'locale', label: 'Locale', hint: 'e.g. en-IN, de-DE' },
              { name: 'taxRegime', label: 'Tax regime', type: 'select', options: [{ value: 'GST', label: 'GST' }, { value: 'VAT', label: 'VAT' }, { value: 'SALES_TAX', label: 'Sales tax' }, { value: 'NONE', label: 'No tax' }] },
              { name: 'taxRegistrationLabel', label: 'Tax ID label', hint: 'GSTIN, VAT ID, TRN…' }, { name: 'taxRegistrationNumber', label: 'Tax registration number' }, { name: 'pricesIncludeTax', label: 'Prices include tax', type: 'checkbox' },
              { name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number' }, { name: 'quotationValidityDays', label: 'Quotation validity (days)', type: 'number' },
              { name: 'invoiceNumberPrefix', label: 'Invoice prefix' }, { name: 'quotationNumberPrefix', label: 'Quotation prefix' }, { name: 'jobNumberPrefix', label: 'Job prefix' }, { name: 'requestNumberPrefix', label: 'Request prefix' },
              { name: 'invoiceFooter', label: 'Invoice footer (bank details, notes)', type: 'textarea' }, { name: 'quotationTerms', label: 'Default quotation terms', type: 'textarea' }]}
              defaults={{ currency: st.currency, timezone: st.timezone, locale: st.locale, taxRegime: st.tax_regime, taxRegistrationLabel: st.tax_registration_label, taxRegistrationNumber: st.tax_registration_number ?? '', pricesIncludeTax: st.prices_include_tax,
                paymentTermsDays: st.payment_terms_days, quotationValidityDays: st.quotation_validity_days, invoiceNumberPrefix: st.invoice_number_prefix, quotationNumberPrefix: st.quotation_number_prefix, jobNumberPrefix: st.job_number_prefix,
                requestNumberPrefix: st.request_number_prefix, invoiceFooter: st.invoice_footer ?? '', quotationTerms: st.quotation_terms ?? '' }}
              onSubmit={(v) => saveSettings({ ...v, currency: v.currency?.toUpperCase() })} /></CardBody></Card>
          <SimpleList title="Tax rates" description="Use components for split taxes, e.g. CGST 9% + SGST 9%." path="tax-rates" rows={s.taxRates}
            columns={[{ key: 'n', header: 'Name', cell: (r: any) => <span>{r.name} {r.is_default && <Badge tone="blue">Default</Badge>} {!r.is_active && <Badge>Inactive</Badge>}</span> }, { key: 'r', header: 'Rate', cell: (r: any) => `${Number(r.rate)}%` },
              { key: 'c', header: 'Components', cell: (r: any) => (r.components ?? []).map((c: any) => `${c.name} ${c.rate}%`).join(' + ') || '—' }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'rate', label: 'Rate %', type: 'number', step: 'any', required: true }, { name: 'isDefault', label: 'Default for new lines', type: 'checkbox' }, { name: 'isActive', label: 'Active', type: 'checkbox' }]}
            toDefaults={(r) => ({ name: r.name, rate: Number(r.rate), isDefault: r.is_default, isActive: r.is_active })} />
        </>}
        {tab === 'operations' && <Card><CardHeader title="Working hours & operations" /><CardBody>
          <SaveForm fields={[{ name: 'workingHoursStart', label: 'Day starts', type: 'time' }, { name: 'workingHoursEnd', label: 'Day ends', type: 'time' },
            { name: 'cancellationNoticeHours', label: 'Cancellation notice (hours)', type: 'number' }, { name: 'documentRetentionDays', label: 'Document retention (days)', type: 'number', hint: 'Blank = keep indefinitely' },
            { name: 'cancellationPolicy', label: 'Cancellation policy', type: 'textarea' }, { name: 'preventDoubleBooking', label: 'Prevent overlapping technician assignments', type: 'checkbox' },
            { name: 'inventoryEnabled', label: 'Track inventory (deduct stock when parts are used)', type: 'checkbox' }, { name: 'technicianCanSeePrices', label: 'Technicians can see prices', type: 'checkbox' },
            { name: 'publicRequestFormEnabled', label: 'Accept requests from the public form', type: 'checkbox' }, { name: 'locationTrackingEnabled', label: 'Technician location sharing (requires technician consent)', type: 'checkbox' }]}
            defaults={{ workingHoursStart: st.working_hours_start.slice(0, 5), workingHoursEnd: st.working_hours_end.slice(0, 5), cancellationNoticeHours: st.cancellation_notice_hours, documentRetentionDays: st.document_retention_days ?? '',
              cancellationPolicy: st.cancellation_policy ?? '', preventDoubleBooking: st.prevent_double_booking, inventoryEnabled: st.inventory_enabled, technicianCanSeePrices: st.technician_can_see_prices,
              publicRequestFormEnabled: st.public_request_form_enabled, locationTrackingEnabled: st.location_tracking_enabled }}
            onSubmit={(v) => saveSettings(v)} />
          <div className="mt-6 border-t border-slate-100 pt-4"><p className="label">Working days</p><div className="flex flex-wrap gap-3">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => <Checkbox key={d} label={d} checked={st.working_days.includes(i + 1)}
            onChange={(e) => saveSettings({ workingDays: e.target.checked ? [...st.working_days, i + 1] : st.working_days.filter((x: number) => x !== i + 1) }).then(() => toast.success('Saved')).catch(toastError)} />)}</div></div>
        </CardBody></Card>}
        {tab === 'catalog' && <div className="grid gap-6 lg:grid-cols-2">
          <SimpleList title="Service categories" path="service-categories" rows={s.serviceCategories} columns={[{ key: 'n', header: 'Name', cell: (r: any) => <span>{r.name} {!r.is_active && <Badge>Inactive</Badge>}</span> },
            { key: 'd', header: 'Duration', cell: (r: any) => `${r.default_duration_minutes} min` }, { key: 'p', header: 'Labour rate', cell: (r: any) => r.default_price ?? '—' }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'defaultDurationMinutes', label: 'Default duration (min)', type: 'number' }, { name: 'defaultPrice', label: 'Default labour rate', type: 'money' }, { name: 'isActive', label: 'Active', type: 'checkbox' }, { name: 'description', label: 'Description', type: 'textarea' }]}
            toDefaults={(r) => ({ name: r.name, defaultDurationMinutes: r.default_duration_minutes, defaultPrice: r.default_price ?? '', isActive: r.is_active, description: r.description ?? '' })} />
          <SimpleList title="Equipment categories" path="equipment-categories" rows={s.equipmentCategories} columns={[{ key: 'n', header: 'Name', cell: (r: any) => r.name }, { key: 'i', header: 'Service interval', cell: (r: any) => r.maintenance_interval_days ? `${r.maintenance_interval_days} days` : '—' }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'maintenanceIntervalDays', label: 'Maintenance interval (days)', type: 'number', hint: 'Used to set next service due' }]}
            toDefaults={(r) => ({ name: r.name, maintenanceIntervalDays: r.maintenance_interval_days ?? '' })} />
          <SimpleList title="Stock locations" path="stock-locations" rows={s.stockLocations} columns={[{ key: 'n', header: 'Name', cell: (r: any) => r.name }, { key: 't', header: 'Type', cell: (r: any) => titleCase(r.location_type) }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'locationType', label: 'Type', type: 'select', options: ['warehouse', 'van', 'store'].map((t) => ({ value: t, label: titleCase(t) })) }]}
            toDefaults={(r) => ({ name: r.name, locationType: r.location_type })} />
        </div>}
        {tab === 'areas' && <div className="grid gap-6 lg:grid-cols-2">
          <SimpleList title="Service areas" description="Postal codes route jobs to technicians covering the area." path="service-areas" rows={s.serviceAreas} columns={[{ key: 'n', header: 'Area', cell: (r: any) => r.name }, { key: 'p', header: 'Postal codes', cell: (r: any) => r.postal_codes.join(', ') || '—' }]}
            fields={[{ name: 'name', label: 'Name', required: true }, { name: 'postalCodes', label: 'Postal codes (comma separated)' }, { name: 'description', label: 'Description', type: 'textarea' }]}
            toDefaults={(r) => ({ name: r.name, postalCodes: r.postal_codes.join(', '), description: r.description ?? '' })} />
          <SimpleList title="Holidays" path="holidays" rows={s.holidays} columns={[{ key: 'd', header: 'Date', cell: (r: any) => date(r.date) }, { key: 'n', header: 'Holiday', cell: (r: any) => r.name }]}
            fields={[{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'name', label: 'Name', required: true }]} toDefaults={(r) => ({ date: r.date, name: r.name })} />
        </div>}
        {tab === 'branches' && <SimpleListBranches rows={s.branches} />}
        {tab === 'users' && <UsersRoles />}
        {tab === 'notifications' && <Card><CardHeader title="Customer notification preferences" description="Which channels are used for each event. Customers can also opt out individually. WhatsApp and SMS need an active integration."
          actions={<Button size="sm" onClick={() => saveSettings({ notificationPreferences: prefs }).then(() => toast.success('Saved')).catch(toastError)}>Save</Button>} />
          <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr><th className="table-th">Event</th><th className="table-th">Email</th><th className="table-th">WhatsApp</th><th className="table-th">SMS</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{EVENTS.map((ev) => <tr key={ev}><td className="table-td">{titleCase(ev.replace('.', ' · '))}</td>{(['email', 'whatsapp', 'sms'] as const).map((ch) => {
              const val = prefs[ev]?.[ch] ?? (ch !== 'sms');
              return <td key={ch} className="table-td"><input type="checkbox" aria-label={`${ev} ${ch}`} className="h-4 w-4 rounded border-slate-300" checked={val} onChange={(e) => setPrefs({ ...prefs, [ev]: { ...(prefs[ev] ?? {}), [ch]: e.target.checked } })} /></td>; })}</tr>)}</tbody></table></div></Card>}
        {tab === 'access' && <SupportAccess />}
        {tab === 'privacy' && <><Alert tone="blue">These tools support GDPR-style requests. Compliance also depends on your own processes, contracts and legal obligations.</Alert><Privacy /></>}
        {tab === 'audit' && <AuditLog />}
      </div>
    </div>
  );
}

function SimpleListBranches({ rows }: { rows: any[] }) {
  const qc = useQueryClient();
  const { feature } = useAuth();
  const [edit, setEdit] = useState<any>(null);
  return (
    <Card><CardHeader title="Branches" description={feature('multi_branch') ? 'Branch managers see only their branch’s jobs, customers and stock. Owners see everything.' : 'Multiple branches are available on the Enterprise plan.'}
      actions={<Button size="sm" variant="outline" onClick={() => setEdit({})}><Plus />Add branch</Button>} />
      <DataTable rows={rows} onRowClick={setEdit} columns={[{ key: 'n', header: 'Branch', cell: (r: any) => <span>{r.name} {r.is_headquarters && <Badge tone="navy">HQ</Badge>}</span> }, { key: 'c', header: 'Code', cell: (r: any) => r.code },
        { key: 'city', header: 'City', cell: (r: any) => r.city ?? '—' }, { key: 's', header: 'Status', cell: (r: any) => <StatusBadge status={r.is_active ? 'active' : 'inactive'} /> }]} />
      <FormDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? 'Edit branch' : 'New branch'} fields={[{ name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, hint: '2–10 letters/numbers' },
        { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'addressLine1', label: 'Address', span: 2 }, { name: 'city', label: 'City' }, { name: 'postalCode', label: 'Postal code' }, { name: 'isActive', label: 'Active', type: 'checkbox' }]}
        defaultValues={edit?.id ? { name: edit.name, code: edit.code, phone: edit.phone ?? '', email: edit.email ?? '', addressLine1: edit.address_line1 ?? '', city: edit.city ?? '', postalCode: edit.postal_code ?? '', isActive: edit.is_active } : { isActive: true }}
        onSubmit={async (v) => { edit?.id ? await patch(`/app/settings/branches/${edit.id}`, v) : await post('/app/settings/branches', v); qc.invalidateQueries({ queryKey: ['settings-lists'] }); }} successMessage="Branch saved" />
    </Card>
  );
}
