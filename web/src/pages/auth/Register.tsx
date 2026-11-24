import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Alert, Button, Checkbox, Field, Input, Select } from '@/components/ui';
import { applyServerErrors } from '@/components/form';
import { AuthLayout } from './AuthLayout';

export const COUNTRIES = [['IN', 'India'], ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['ES', 'Spain'],
  ['IT', 'Italy'], ['PT', 'Portugal'], ['BE', 'Belgium'], ['AT', 'Austria'], ['PL', 'Poland'], ['SE', 'Sweden'], ['SA', 'Saudi Arabia'], ['US', 'United States'], ['AU', 'Australia'], ['SG', 'Singapore'], ['ZZ', 'Other']]
  .map(([value, label]) => ({ value, label }));

export default function Register() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { acceptToken } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ defaultValues: { businessName: '', fullName: '', email: '', phone: '', password: '', country: 'IN', acceptTerms: false } });
  const { register, handleSubmit, formState: { errors, isSubmitting } } = form;
  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await post('/auth/register', { ...v, phone: v.phone || undefined, planCode: sp.get('plan') ?? undefined });
      await acceptToken(r.data.accessToken);
      nav('/app/onboarding', { replace: true });
    } catch (e) { if (!applyServerErrors(form, e, ['businessName', 'fullName', 'email', 'password', 'phone', 'acceptTerms'])) setError((e as Error).message); }
  });
  return (
    <AuthLayout title="Create your business account" subtitle="Start a free trial. No card required." footer={<>Already have an account? <Link className="font-medium text-brand-700" to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Alert tone="red">{error}</Alert>}
        <Field label="Business name" error={errors.businessName?.message} required><Input invalid={!!errors.businessName} {...register('businessName', { required: 'Business name is required', minLength: { value: 2, message: 'Too short' } })} /></Field>
        <Field label="Your name" error={errors.fullName?.message} required><Input autoComplete="name" invalid={!!errors.fullName} {...register('fullName', { required: 'Your name is required' })} /></Field>
        <Field label="Work email" error={errors.email?.message} required><Input type="email" autoComplete="email" invalid={!!errors.email} {...register('email', { required: 'Email is required', pattern: { value: /\S+@\S+\.\S+/, message: 'Enter a valid email' } })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country" required><Select options={COUNTRIES} {...register('country')} /></Field>
          <Field label="Phone"><Input type="tel" autoComplete="tel" {...register('phone')} /></Field>
        </div>
        <Field label="Password" error={errors.password?.message} hint="At least 10 characters with letters and numbers" required>
          <Input type="password" autoComplete="new-password" invalid={!!errors.password} {...register('password', { required: 'Password is required', minLength: { value: 10, message: 'At least 10 characters' } })} /></Field>
        <Checkbox {...register('acceptTerms', { required: true })} label={<>I agree to the <Link to="/terms" className="text-brand-700">Terms</Link> and <Link to="/privacy" className="text-brand-700">Privacy Policy</Link></>} />
        {errors.acceptTerms && <p className="text-xs text-red-600">Please accept the terms to continue</p>}
        <Button type="submit" className="w-full" size="lg" loading={isSubmitting}>Create account</Button>
      </form>
    </AuthLayout>
  );
}
