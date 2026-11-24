import * as React from 'react';
import { useForm, type DefaultValues, type FieldValues, type Path } from 'react-hook-form';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from './ui';
import { cn } from '@/lib/utils';

export interface FieldDef {
  name: string; label: string; type?: 'text' | 'email' | 'tel' | 'number' | 'money' | 'textarea' | 'select' | 'date' | 'datetime-local' | 'time' | 'checkbox' | 'password';
  options?: { value: string; label: string }[]; required?: boolean; placeholder?: string; hint?: string; span?: 1 | 2; min?: number; max?: number; step?: number | string;
  disabled?: boolean; rows?: number; autoComplete?: string;
}

/** Normalises form values for the API: '' -> null for optional fields, numbers parsed. */
export function cleanValues(fields: FieldDef[], values: Record<string, any>) {
  const out: Record<string, any> = { ...values };
  for (const f of fields) {
    const v = out[f.name];
    if (f.type === 'number' || f.type === 'money') out[f.name] = v === '' || v === null || v === undefined || Number.isNaN(v) ? (f.required ? undefined : null) : Number(v);
    else if (f.type === 'checkbox') out[f.name] = !!v;
    else if (typeof v === 'string') out[f.name] = v.trim() === '' ? (f.required ? '' : null) : v.trim();
  }
  return out;
}

export function errorMessage(e: unknown) {
  if (e instanceof ApiError) {
    const fe = e.fieldErrors(); const k = Object.keys(fe);
    return k.length ? `${e.message}: ${k.map((x) => `${x} — ${fe[x]}`).join('; ')}` : e.message;
  }
  return (e as Error)?.message ?? 'Something went wrong';
}
export const toastError = (e: unknown) => toast.error(errorMessage(e));

export function FormFields<T extends FieldValues>({ fields, form, cols = 2 }: { fields: FieldDef[]; form: ReturnType<typeof useForm<T>>; cols?: 1 | 2 }) {
  const { register, formState: { errors } } = form;
  return (
    <div className={cn('grid gap-4', cols === 2 && 'sm:grid-cols-2')}>
      {fields.map((f) => {
        const err = (errors as any)[f.name]?.message as string | undefined;
        const reg = register(f.name as Path<T>, { required: f.required && f.type !== 'checkbox' ? `${f.label} is required` : false,
          valueAsNumber: f.type === 'number' || f.type === 'money' ? true : undefined } as any);
        const id = `f-${f.name}`;
        const span = f.span === 2 || f.type === 'textarea' ? 'sm:col-span-2' : '';
        if (f.type === 'checkbox') return <div key={f.name} className={span}><Checkbox id={id} label={f.label} hint={f.hint} {...reg} disabled={f.disabled} /></div>;
        return (
          <Field key={f.name} label={f.label} required={f.required} error={err} hint={f.hint} className={span} htmlFor={id}>
            {f.type === 'textarea' ? <Textarea id={id} rows={f.rows ?? 3} invalid={!!err} placeholder={f.placeholder} disabled={f.disabled} {...reg} />
              : f.type === 'select' ? <Select id={id} invalid={!!err} options={f.options} placeholder={f.required ? 'Select…' : '—'} disabled={f.disabled} {...reg} />
              : <Input id={id} type={f.type === 'money' ? 'number' : f.type ?? 'text'} step={f.type === 'money' ? '0.01' : f.step} min={f.min} max={f.max} invalid={!!err}
                  placeholder={f.placeholder} disabled={f.disabled} autoComplete={f.autoComplete} {...reg} />}
          </Field>
        );
      })}
    </div>
  );
}

/** Applies server-side validation errors to the form; returns true if any were mapped. */
export function applyServerErrors(form: { setError: (n: any, e: any) => void }, e: unknown, fields: string[]) {
  if (!(e instanceof ApiError)) return false;
  const fe = e.fieldErrors(); let mapped = false;
  for (const [k, msg] of Object.entries(fe)) if (fields.includes(k)) { form.setError(k, { type: 'server', message: msg }); mapped = true; }
  return mapped;
}

export function FormDialog<T extends FieldValues = any>({ open, onOpenChange, title, description, fields, defaultValues, onSubmit, submitLabel = 'Save', size = 'md', cols = 2, children, successMessage }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; fields: FieldDef[]; defaultValues?: DefaultValues<T>;
  onSubmit: (values: any) => Promise<unknown>; submitLabel?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; cols?: 1 | 2; children?: React.ReactNode; successMessage?: string;
}) {
  const form = useForm<T>({ defaultValues });
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) form.reset(defaultValues); }, [open]); // eslint-disable-line
  const submit = form.handleSubmit(async (values) => {
    setBusy(true);
    try {
      await onSubmit(cleanValues(fields, values));
      if (successMessage) toast.success(successMessage);
      onOpenChange(false);
    } catch (e) {
      if (!applyServerErrors(form, e, fields.map((f) => f.name))) toastError(e);
    } finally { setBusy(false); }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} size={size}
      footer={<><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy} onClick={submit}>{submitLabel}</Button></>}>
      <form onSubmit={submit} noValidate>
        <FormFields fields={fields} form={form as any} cols={cols} />
        {children}
        <button type="submit" className="hidden" />
      </form>
    </Dialog>
  );
}
