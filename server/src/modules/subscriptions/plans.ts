/**
 * Initial plan definitions inserted ONCE on first boot. After that, every price, limit and feature
 * is edited by the Super Admin in the database; the application never reads prices from code.
 */
export const FEATURE_KEYS = {
  crm: 'Customer management', service_requests: 'Service requests', work_orders: 'Work orders',
  technician_portal: 'Technician mobile portal', basic_reports: 'Basic reports', customer_portal: 'Customer portal',
  quotations: 'Quotations', invoicing: 'Invoicing & payments', amc: 'AMC contracts', notifications: 'Email/WhatsApp/SMS notifications',
  advanced_reports: 'Advanced reports', inventory: 'Inventory', advanced_permissions: 'Custom roles & permissions',
  ai: 'AI assistant', integrations: 'Integrations', multi_branch: 'Multiple branches', dispatch_optimizer: 'Dispatch suggestions',
} as const;
export type FeatureKey = keyof typeof FEATURE_KEYS;

const f = (...keys: FeatureKey[]) => Object.fromEntries(keys.map((k) => [k, true]));
const base: FeatureKey[] = ['crm', 'service_requests', 'work_orders', 'technician_portal', 'basic_reports', 'customer_portal'];
const growth: FeatureKey[] = [...base, 'quotations', 'invoicing', 'amc', 'notifications', 'advanced_reports', 'dispatch_optimizer'];
const business: FeatureKey[] = [...growth, 'inventory', 'advanced_permissions', 'ai', 'integrations'];

export const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', description: 'For small teams getting organised', currency: 'USD', monthly: 29, annual: 290, trialDays: 14,
    maxUsers: 5, maxTechnicians: 2, maxStorageMb: 2048, maxBranches: 1, aiRequests: 0, features: f(...base), sort: 1, isPublic: true },
  { code: 'growth', name: 'Growth', description: 'Quotations, invoicing, AMC and notifications', currency: 'USD', monthly: 79, annual: 790, trialDays: 14,
    maxUsers: 20, maxTechnicians: 10, maxStorageMb: 10240, maxBranches: 1, aiRequests: 0, features: f(...growth), sort: 2, isPublic: true },
  { code: 'business', name: 'Business', description: 'Inventory, AI and integrations for scaling operations', currency: 'USD', monthly: 199, annual: 1990, trialDays: 14,
    maxUsers: 60, maxTechnicians: 25, maxStorageMb: 51200, maxBranches: 3, aiRequests: 2000, features: f(...business), sort: 3, isPublic: true },
  { code: 'enterprise', name: 'Enterprise', description: 'Custom limits, multiple branches and negotiated support', currency: 'USD', monthly: 0, annual: 0, trialDays: 30,
    maxUsers: null, maxTechnicians: null, maxStorageMb: null, maxBranches: 100, aiRequests: 20000, features: f(...business, 'multi_branch'), sort: 4, isPublic: false },
];
