import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Eye, FolderOpen } from 'lucide-react';
import { openFile } from '@/lib/api';
import { useData } from '@/lib/hooks';
import { dateTime } from '@/lib/format';
import { fileSize, titleCase } from '@/lib/utils';
import { Button, Card, DataTable, EmptyState, PageHeader, SearchInput, Select } from '@/components/ui';
import { toastError } from '@/components/form';
import { useFilePreview } from './shared';

const LINK: Record<string, string> = { customer: 'customers', asset: 'assets', work_order: 'work-orders', service_request: 'requests', quotation: 'quotations', invoice: 'invoices', amc_contract: 'amc', support_ticket: 'support', technician: 'technicians' };
export default function Documents() {
  const [f, setF] = useState({ q: '', entityType: '', category: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as any).toString();
  const { data, isLoading, error, refetch } = useData<any[]>(['documents', qs], `/app/documents?${qs}`);
  const pv = useFilePreview();
  return (
    <div>
      <PageHeader title="Documents" description="Private files: photos, warranties, contracts and reports. Access follows the permissions of the record they belong to; previews use short-lived signed links." />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-4"><SearchInput className="w-full sm:w-64" value={f.q} onChange={(q) => setF({ ...f, q })} placeholder="File name…" />
          <Select aria-label="Record type" className="w-44" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })} placeholder="All records" options={Object.keys(LINK).map((k) => ({ value: k, label: titleCase(k) }))} />
          <Select aria-label="Category" className="w-48" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="All categories" options={['photo_before', 'photo_after', 'service_photo', 'equipment_document', 'warranty_certificate', 'contract', 'signature', 'customer_attachment', 'attachment'].map((k) => ({ value: k, label: titleCase(k) }))} /></div>
        <DataTable rows={data} loading={isLoading} error={error} onRetry={refetch} empty={<EmptyState icon={FolderOpen} title="No documents" description="Upload files from customers, jobs, assets and contracts." />} columns={[
          { key: 'n', header: 'File', cell: (d: any) => <div><p className="font-medium">{d.file_name}</p><p className="text-xs text-slate-500">{fileSize(Number(d.size_bytes))} · {titleCase(d.category)}</p></div> },
          { key: 'r', header: 'Belongs to', cell: (d: any) => LINK[d.entity_type] ? <Link className="text-brand-700" to={`/app/${LINK[d.entity_type]}/${d.entity_id}`}>{titleCase(d.entity_type)}</Link> : titleCase(d.entity_type) },
          { key: 'u', header: 'Uploaded', hideOnMobile: true, cell: (d: any) => <div><p>{dateTime(d.created_at)}</p><p className="text-xs text-slate-500">{d.uploaded_by_name}</p></div> },
          { key: 'x', header: '', cell: (d: any) => <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label="Preview" onClick={() => pv.open(d)}><Eye /></Button>
            <Button size="icon-sm" variant="ghost" aria-label="Download" onClick={() => openFile(`/app/documents/${d.id}/download`, d.file_name).catch(toastError)}><Download /></Button></div> }]} />
      </Card>
      {pv.node}
    </div>
  );
}
