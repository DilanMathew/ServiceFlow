import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Inbox, Loader2, Search, X } from 'lucide-react';
import { statusLabel, t, useT } from '@/lib/i18n';
import { cn, initials, titleCase } from '@/lib/utils';

// ---------------------------------------------------------------- Button
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        navy: 'bg-navy-900 text-white shadow-sm hover:bg-navy-800',
        secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200',
        outline: 'border border-slate-300 bg-white text-slate-800 shadow-sm hover:bg-slate-50',
        ghost: 'text-slate-700 hover:bg-slate-100',
        danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
        'danger-outline': 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
        link: 'text-brand-700 underline-offset-4 hover:underline px-0',
      },
      size: { sm: 'h-8 px-3 text-xs', md: 'h-9 px-4', lg: 'h-11 px-5 text-base', icon: 'h-9 w-9', 'icon-sm': 'h-8 w-8' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean; loading?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {asChild ? children : <>{loading && <Loader2 className="animate-spin" />}{children}</>}
    </Comp>
  );
});
Button.displayName = 'Button';

// ---------------------------------------------------------------- Form controls
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(({ className, invalid, ...p }, ref) => (
  <input ref={ref} className={cn('input', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...p} />
));
Input.displayName = 'Input';
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(({ className, invalid, ...p }, ref) => (
  <textarea ref={ref} className={cn('input min-h-[88px] resize-y', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...p} />
));
Textarea.displayName = 'Textarea';
export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; options?: { value: string; label: string }[]; placeholder?: string }>(
  ({ className, invalid, options, placeholder, children, ...p }, ref) => (
    <select ref={ref} className={cn('input pr-8', invalid && 'input-error', className)} aria-invalid={invalid || undefined} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {children}
    </select>
  ));
Select.displayName = 'Select';
export const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode; hint?: string }>(({ label, hint, className, ...p }, ref) => (
  <label className={cn('flex cursor-pointer items-start gap-2.5 text-sm text-slate-700', className)}>
    <input ref={ref} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" {...p} />
    <span>{label}{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
  </label>
));
Checkbox.displayName = 'Checkbox';

export function Field({ label, error, hint, required, children, className, htmlFor }: { label?: React.ReactNode; error?: string; hint?: React.ReactNode; required?: boolean; children: React.ReactNode; className?: string; htmlFor?: string }) {
  // Associate the label with its control for screen readers: reuse the child's id or generate one.
  const auto = React.useId();
  const child = React.Children.count(children) === 1 && React.isValidElement(children) && typeof children.type !== 'string' || (React.isValidElement(children) && ['input', 'select', 'textarea'].includes(children.type as string)) ? (children as React.ReactElement<any>) : null;
  const id = htmlFor ?? child?.props.id ?? (child ? auto : undefined);
  const control = child && !child.props.id && id ? React.cloneElement(child, { id, 'aria-describedby': error || hint ? `${id}-msg` : undefined }) : children;
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}{required && <span className="ml-0.5 text-red-500" aria-hidden>*</span>}</label>}
      {control}
      {error ? <p role="alert" id={id ? `${id}-msg` : undefined} className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p id={id ? `${id}-msg` : undefined} className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Card
export const Card = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('card', className)} {...p} />;
export function CardHeader({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4', className)}>
      <div className="min-w-0"><h3 className="text-sm font-semibold text-navy-900">{title}</h3>{description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
export const CardBody = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn('p-5', className)} {...p} />;

// ---------------------------------------------------------------- Badge & status
const tones = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200', blue: 'bg-brand-50 text-brand-700 ring-brand-200', green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200', red: 'bg-red-50 text-red-700 ring-red-200', violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  navy: 'bg-navy-900 text-white ring-navy-900', cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-200',
} as const;
export type Tone = keyof typeof tones;
export function Badge({ tone = 'slate', className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}
const STATUS_TONE: Record<string, Tone> = {
  new: 'blue', approved: 'cyan', scheduled: 'violet', assigned: 'violet', en_route: 'amber', in_progress: 'amber', on_hold: 'red', completed: 'green', invoiced: 'cyan', paid: 'green',
  cancelled: 'slate', rejected: 'slate', under_review: 'amber', converted: 'green', draft: 'slate', sent: 'blue', viewed: 'violet', expired: 'slate', superseded: 'slate',
  issued: 'blue', partially_paid: 'amber', overdue: 'red', refunded: 'slate', partially_refunded: 'amber', succeeded: 'green', pending: 'amber', failed: 'red',
  active: 'green', inactive: 'slate', archived: 'slate', renewed: 'cyan', trialing: 'blue', past_due: 'red', grace_period: 'amber', suspended: 'red',
  open: 'blue', waiting_for_customer: 'amber', resolved: 'green', closed: 'slate', queued: 'slate', sending: 'amber', delivered: 'green', skipped: 'slate',
  urgent: 'red', high: 'amber', normal: 'slate', low: 'slate', under_repair: 'amber', replaced: 'slate', decommissioned: 'slate', work_order_created: 'violet', missed: 'red',
  ok: 'green', error: 'red', unconfigured: 'slate', on_leave: 'amber', terminated: 'slate', reviewed: 'cyan', action_taken: 'green', dismissed: 'slate',
};
export function StatusBadge({ status, label }: { status?: string | null; label?: string }) {
  useT(); // re-render on language change
  return status ? <Badge tone={STATUS_TONE[status] ?? 'slate'}>{label ?? statusLabel(status)}</Badge> : null;
}

// ---------------------------------------------------------------- Feedback states
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('h-5 w-5 animate-spin text-brand-600', className)} aria-label={t('Loading')} />;
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} />;
export const PageLoader = () => <div className="flex h-64 items-center justify-center"><Spinner className="h-7 w-7" /></div>;

export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: React.ElementType; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-600"><Icon className="h-5 w-5" /></div>
      <p className="text-sm font-semibold text-navy-900">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useT();
  const msg = (error as Error)?.message ?? t('Something went wrong');
  const code = (error as any)?.code;
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center" role="alert">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-50 text-red-600"><AlertTriangle className="h-5 w-5" /></div>
      <p className="text-sm font-semibold text-navy-900">{code === 'FEATURE_NOT_IN_PLAN' ? t('Not included in your plan') : code === 'FORBIDDEN' ? t('Access denied') : t('Could not load this page')}</p>
      <p className="mt-1 max-w-md text-sm text-slate-500">{msg}</p>
      {code === 'FEATURE_NOT_IN_PLAN' ? <a href="/app/subscription" className="mt-4"><Button size="sm">{t('View plans')}</Button></a>
        : onRetry && <Button size="sm" variant="outline" className="mt-4" onClick={onRetry}>{t('Try again')}</Button>}
    </div>
  );
}

// ---------------------------------------------------------------- Page header
export function PageHeader({ title, description, actions, back, children }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; back?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-6">
      {back && <div className="mb-2">{back}</div>}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-navy-900 sm:text-2xl">{title}</h1>
          {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Dialog
export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md' }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const w = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-navy-950/40 backdrop-blur-[2px] animate-fade-in" />
        <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-pop animate-slide-up', w)}>
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div>
              <DialogPrimitive.Title className="text-base font-semibold text-navy-900">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-slate-500">{description}</DialogPrimitive.Description> : <DialogPrimitive.Description className="sr-only">{String(title)}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label={t('Close')}><X className="h-4 w-4" /></DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Promise-based confirmation for destructive actions: `if (await confirm({...})) ...` */
type ConfirmOpts = { title: string; description?: React.ReactNode; confirmLabel?: string; danger?: boolean; requireReason?: boolean; reasonLabel?: string };
const ConfirmCtx = React.createContext<(o: ConfirmOpts) => Promise<false | { reason: string }>>(async () => false);
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<(ConfirmOpts & { resolve: (v: false | { reason: string }) => void }) | null>(null);
  const [reason, setReason] = React.useState('');
  const confirm = React.useCallback((o: ConfirmOpts) => new Promise<false | { reason: string }>((resolve) => { setReason(''); setState({ ...o, resolve }); }), []);
  const close = (v: false | { reason: string }) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={!!state} onOpenChange={(o) => !o && close(false)} title={state?.title ?? ''} description={state?.description} size="sm"
        footer={<><Button variant="outline" onClick={() => close(false)}>{t('Cancel')}</Button>
          <Button variant={state?.danger ? 'danger' : 'primary'} disabled={state?.requireReason && reason.trim().length < 3} onClick={() => close({ reason: reason.trim() })}>{state?.confirmLabel ?? t('Confirm')}</Button></>}>
        {state?.requireReason ? <Field label={state.reasonLabel ?? t('Reason')} required><Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} /></Field>
          : <p className="text-sm text-slate-600">This action cannot be undone.</p>}
      </Dialog>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => React.useContext(ConfirmCtx);

// ---------------------------------------------------------------- Tabs
export function Tabs({ tabs, value, onValueChange, children, className }: { tabs: { value: string; label: React.ReactNode; count?: number }[]; value: string; onValueChange: (v: string) => void; children?: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={className}>
      <TabsPrimitive.List className="-mb-px flex gap-1 overflow-x-auto border-b border-slate-200" aria-label="Sections">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger key={tab.value} value={tab.value} className="whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-1 text-sm font-medium text-slate-500 hover:text-slate-800 data-[state=active]:border-brand-600 data-[state=active]:text-brand-700">
            {tab.label}{tab.count !== undefined && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  );
}

// ---------------------------------------------------------------- Dropdown
export function Menu({ trigger, items, align = 'end' }: { trigger: React.ReactNode; align?: 'start' | 'end'; items: ({ label: React.ReactNode; onSelect: () => void; danger?: boolean; icon?: React.ElementType; disabled?: boolean } | 'sep')[] }) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content align={align} sideOffset={6} className="z-50 min-w-[180px] rounded-lg border border-slate-200 bg-white p-1 shadow-pop animate-fade-in">
          {items.map((it, i) => it === 'sep' ? <DropdownPrimitive.Separator key={i} className="my-1 h-px bg-slate-100" /> : (
            <DropdownPrimitive.Item key={i} disabled={it.disabled} onSelect={it.onSelect}
              className={cn('flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-slate-100', it.danger ? 'text-red-600' : 'text-slate-700')}>
              {it.icon && <it.icon className="h-4 w-4" />}{it.label}
            </DropdownPrimitive.Item>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

// ---------------------------------------------------------------- Data table
export interface Column<T> { key: string; header: React.ReactNode; cell: (row: T) => React.ReactNode; sortable?: boolean; className?: string; hideOnMobile?: boolean }
export function DataTable<T extends { id?: string }>({ columns, rows, loading, error, onRetry, empty, onRowClick, sort, onSort, meta, onPage, selectable, selected, onSelect }: {
  columns: Column<T>[]; rows?: T[]; loading?: boolean; error?: unknown; onRetry?: () => void; empty?: React.ReactNode; onRowClick?: (r: T) => void;
  sort?: { key: string; order: 'asc' | 'desc' }; onSort?: (key: string) => void; meta?: { page: number; totalPages: number; total: number; pageSize: number }; onPage?: (p: number) => void;
  selectable?: boolean; selected?: Set<string>; onSelect?: (s: Set<string>) => void;
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  const all = rows?.length && selected ? rows.every((r) => selected.has(r.id!)) : false;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="bg-slate-50/70">
            <tr>
              {selectable && <th className="w-10 px-4"><input type="checkbox" aria-label="Select all" className="h-4 w-4 rounded border-slate-300" checked={all}
                onChange={() => onSelect?.(all ? new Set() : new Set(rows?.map((r) => r.id!)))} /></th>}
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn('table-th', c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => onSort(c.key)}>
                      {c.header}{sort?.key === c.key ? (sort.order === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {loading && !rows?.length ? Array.from({ length: 6 }).map((_, i) => (
              <tr key={i}>{selectable && <td />}{columns.map((c) => <td key={c.key} className={cn('table-td', c.hideOnMobile && 'hidden md:table-cell')}><Skeleton className="h-4 w-3/4" /></td>)}</tr>
            )) : rows?.map((r, i) => (
              <tr key={r.id ?? i} className={cn('transition-colors', onRowClick && 'cursor-pointer hover:bg-slate-50')} onClick={() => onRowClick?.(r)}>
                {selectable && <td className="px-4" onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label="Select row" className="h-4 w-4 rounded border-slate-300" checked={selected?.has(r.id!) ?? false}
                  onChange={() => { const s = new Set(selected); s.has(r.id!) ? s.delete(r.id!) : s.add(r.id!); onSelect?.(s); }} /></td>}
                {columns.map((c) => <td key={c.key} className={cn('table-td', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!loading && rows && rows.length === 0 && (empty ?? <EmptyState title={t('Nothing here yet')} />)}
      {meta && meta.totalPages > 1 && onPage && <Pagination meta={meta} onPage={onPage} />}
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: { page: number; totalPages: number; total: number; pageSize: number }; onPage: (p: number) => void }) {
  const from = (meta.page - 1) * meta.pageSize + 1, to = Math.min(meta.page * meta.pageSize, meta.total);
  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
      <span className="tabular">{t('{from}–{to} of {total}', { from, to, total: meta.total })}</span>
      <div className="flex gap-1">
        <Button size="icon-sm" variant="outline" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label={t('Previous page')}><ChevronLeft /></Button>
        <Button size="icon-sm" variant="outline" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)} aria-label={t('Next page')}><ChevronRight /></Button>
      </div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => setV(value), [value]);
  React.useEffect(() => { const timer = setTimeout(() => v !== value && onChange(v), 300); return () => clearTimeout(timer); }, [v]); // eslint-disable-line
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input type="search" aria-label={placeholder} className="input pl-9" placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------- Misc
export function StatCard({ label, value, hint, icon: Icon, tone = 'blue', onClick }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ElementType; tone?: 'blue' | 'green' | 'amber' | 'red' | 'navy' | 'violet'; onClick?: () => void }) {
  const toneCls = { blue: 'bg-brand-50 text-brand-600', green: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600', navy: 'bg-navy-50 text-navy-800', violet: 'bg-violet-50 text-violet-600' }[tone];
  return (
    <Card className={cn('p-4', onClick && 'cursor-pointer transition hover:border-brand-200 hover:shadow-pop')} onClick={onClick}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-1.5 truncate text-2xl font-semibold text-navy-900 tabular">{value}</p>
          {hint && <p className="mt-1 truncate text-xs text-slate-500">{hint}</p>}
        </div>
        {Icon && <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', toneCls)}><Icon className="h-[18px] w-[18px]" /></div>}
      </div>
    </Card>
  );
}

export function Avatar({ name, className }: { name?: string | null; className?: string }) {
  return <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-xs font-semibold text-navy-800', className)} aria-hidden>{initials(name)}</span>;
}

export function DescriptionList({ items, cols = 2 }: { items: [React.ReactNode, React.ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cn('grid gap-x-6 gap-y-4', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3')}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-1 break-words text-sm text-slate-900">{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

export function Alert({ tone = 'blue', title, children, action }: { tone?: 'blue' | 'amber' | 'red' | 'green'; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  const toneCls = { blue: 'border-brand-200 bg-brand-50 text-brand-900', amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900' }[tone];
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm', toneCls)} role="status">
      <div>{title && <p className="font-semibold">{title}</p>}{children && <div className={cn(title && 'mt-0.5')}>{children}</div>}</div>
      {action}
    </div>
  );
}
