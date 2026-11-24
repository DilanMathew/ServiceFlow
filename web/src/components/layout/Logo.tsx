import { cn } from '@/lib/utils';
export function Logo({ light, compact, className }: { light?: boolean; compact?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden><rect width="32" height="32" rx="8" fill={light ? '#2563eb' : '#0b1f44'} />
        <path d="M9 22V10l14 12V10" stroke={light ? '#fff' : '#3b82f6'} strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {!compact ? (
        <span className="leading-tight">
          <span className={cn('block text-[15px] font-bold tracking-tight', light ? 'text-white' : 'text-navy-900')}>NEXUS <span className={light ? 'text-brand-300' : 'text-brand-600'}>ServiceFlow</span></span>
          <span className={cn('block text-[10px] font-medium uppercase tracking-[0.14em]', light ? 'text-navy-300' : 'text-slate-500')}>by NEXUS by DIL</span>
        </span>
      ) : <span className="text-[15px] font-bold tracking-tight text-navy-900">ServiceFlow</span>}
    </span>
  );
}
