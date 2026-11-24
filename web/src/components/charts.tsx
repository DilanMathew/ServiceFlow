import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactMoney, money, num } from '@/lib/format';
import { titleCase } from '@/lib/utils';

/** Validated categorical order (CVD-safe, see dataviz validator). Never cycled: extra series fold into OTHER. */
export const SERIES = ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#db2777'];
export const OTHER = '#94a3b8';
const AXIS = { stroke: '#94a3b8', fontSize: 12, tickLine: false, axisLine: false } as const;
const GRID = <CartesianGrid stroke="#eef2f7" vertical={false} />;

function Tip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-semibold text-slate-800">{label}</p>
      {payload.map((p: any) => <p key={p.dataKey} className="flex items-center gap-2 text-slate-600"><span className="h-2 w-2 rounded-full" style={{ background: p.color ?? p.fill }} />
        {p.name}: <span className="font-medium text-slate-900 tabular">{fmt(p.value)}</span></p>)}
    </div>
  );
}
const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1, 1).toLocaleString(undefined, { month: 'short' }); };

export function MoneyAreaChart({ data, series, height = 260 }: { data: any[]; series: { key: string; name: string }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>{series.map((s, i) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={SERIES[i]} stopOpacity={0.18} /><stop offset="100%" stopColor={SERIES[i]} stopOpacity={0} /></linearGradient>)}</defs>
        {GRID}
        <XAxis dataKey="month" tickFormatter={monthLabel} {...AXIS} />
        <YAxis tickFormatter={(v) => compactMoney(v)} width={64} {...AXIS} />
        <Tooltip content={<Tip fmt={money} />} labelFormatter={monthLabel} cursor={{ stroke: '#cbd5e1', strokeDasharray: '3 3' }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: '#475569' }} />
        {series.map((s, i) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i]} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />)}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Single-series bar (one hue, no legend needed: the card title names it). */
export function SimpleBarChart({ data, x, y, height = 240, horizontal, fmt = num, labelFmt = (v: string) => titleCase(v), color = SERIES[0] }: {
  data: any[]; x: string; y: string; height?: number; horizontal?: boolean; fmt?: (v: any) => string; labelFmt?: (v: string) => string; color?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 12, left: horizontal ? 8 : 0, bottom: 0 }} barCategoryGap={horizontal ? 6 : '25%'}>
        {horizontal ? <CartesianGrid stroke="#eef2f7" horizontal={false} /> : GRID}
        {horizontal ? <><XAxis type="number" tickFormatter={fmt} {...AXIS} /><YAxis type="category" dataKey={x} tickFormatter={labelFmt} width={120} interval={0} {...AXIS} /></>
          : <><XAxis dataKey={x} tickFormatter={labelFmt} interval={0} {...AXIS} /><YAxis tickFormatter={fmt} width={48} allowDecimals={false} {...AXIS} /></>}
        <Tooltip content={<Tip fmt={fmt} />} labelFormatter={labelFmt} cursor={{ fill: '#f1f5f9' }} />
        <Bar dataKey={y} name={titleCase(y)} fill={color} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GroupedBarChart({ data, x, series, height = 260, fmt = num }: { data: any[]; x: string; series: { key: string; name: string }[]; height?: number; fmt?: (v: any) => string }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
        {GRID}
        <XAxis dataKey={x} {...AXIS} interval={0} tickFormatter={(v) => (String(v).length > 12 ? `${String(v).slice(0, 11)}…` : v)} />
        <YAxis tickFormatter={fmt} width={fmt === num ? 40 : 64} allowDecimals={false} {...AXIS} />
        <Tooltip content={<Tip fmt={fmt} />} cursor={{ fill: '#f1f5f9' }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: '#475569' }} />
        {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={SERIES[i] ?? OTHER} radius={[4, 4, 0, 0]} maxBarSize={22} />)}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Ordered buckets on one measure: single hue, darker = older (sequential). */
export function AgingBars({ buckets, height = 200 }: { buckets: { label: string; value: number }[]; height?: number }) {
  const ramp = ['#bfdbfe', '#93c5fd', '#60a5fa', '#2563eb', '#1e3a8a'];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={buckets} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {GRID}
        <XAxis dataKey="label" {...AXIS} interval={0} />
        <YAxis tickFormatter={(v) => compactMoney(v)} width={60} {...AXIS} />
        <Tooltip content={<Tip fmt={money} />} cursor={{ fill: '#f1f5f9' }} />
        <Bar dataKey="value" name="Outstanding" radius={[4, 4, 0, 0]} maxBarSize={44}>{buckets.map((_, i) => <Cell key={i} fill={ramp[i]} />)}</Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
