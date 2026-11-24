import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/layout/Logo';
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <div className="hidden w-[42%] flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <Link to="/"><Logo light /></Link>
        <div>
          <p className="text-3xl font-semibold leading-snug">Manage Every Service.<br /><span className="text-brand-400">Every Customer. Every Job.</span></p>
          <p className="mt-4 max-w-sm text-navy-200">Requests, dispatch, technicians, invoices and maintenance contracts in one secure platform.</p>
        </div>
        <p className="text-xs text-navy-400">© NEXUS by DIL</p>
      </div>
      <div className="flex flex-1 items-center justify-center bg-white px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          <h1 className="text-2xl font-semibold text-navy-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>}
        </div>
      </div>
    </div>
  );
}
