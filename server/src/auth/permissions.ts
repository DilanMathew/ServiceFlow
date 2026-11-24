/** Single source of truth for permissions. Synced into the DB by the seeder/bootstrap. */
export const PERMISSIONS = {
  'dashboard.view': 'View business dashboard',
  'customers.read': 'View customers', 'customers.create': 'Create customers', 'customers.update': 'Edit customers',
  'customers.delete': 'Archive / delete customers', 'customers.import': 'Import customers', 'customers.export': 'Export customers',
  'assets.read': 'View assets', 'assets.manage': 'Create and edit assets',
  'requests.read': 'View service requests', 'requests.create': 'Create service requests', 'requests.review': 'Approve / reject / convert requests',
  'work_orders.read': 'View all work orders', 'work_orders.read_own': 'View own assigned work orders',
  'work_orders.create': 'Create work orders', 'work_orders.update': 'Edit work orders', 'work_orders.assign': 'Assign / reassign technicians',
  'work_orders.status': 'Change work order status', 'work_orders.cancel': 'Cancel work orders', 'work_orders.execute': 'Perform field work (technician)',
  'technicians.read': 'View technicians', 'technicians.manage': 'Manage technicians',
  'dispatch.manage': 'Use dispatch board',
  'quotations.read': 'View quotations', 'quotations.manage': 'Create / edit / send quotations', 'quotations.approve': 'Record approval of quotations',
  'invoices.read': 'View invoices', 'invoices.manage': 'Create / issue invoices', 'invoices.cancel': 'Cancel invoices / issue credit notes',
  'payments.read': 'View payments', 'payments.record': 'Record payments', 'payments.refund': 'Issue refunds', 'payments.reconcile': 'Reconcile payments',
  'inventory.read': 'View inventory', 'inventory.manage': 'Manage catalogue and stock',
  'amc.read': 'View AMC contracts', 'amc.manage': 'Manage AMC contracts',
  'calendar.view': 'View calendar',
  'reports.operational': 'View operational reports', 'reports.financial': 'View financial reports',
  'communications.read': 'View communications', 'communications.manage': 'Manage templates and send messages',
  'support.read': 'View support tickets & feedback', 'support.manage': 'Manage support tickets & feedback',
  'documents.read': 'View documents', 'documents.upload': 'Upload documents', 'documents.delete': 'Delete documents',
  'integrations.manage': 'Configure integrations',
  'ai.use': 'Use AI assistant',
  'subscription.manage': 'Manage NEXUS subscription',
  'settings.manage': 'Manage business settings',
  'users.manage': 'Manage users and roles',
  'branches.manage': 'Manage branches',
  'audit.read': 'View audit logs',
  'privacy.manage': 'Handle data subject requests',
  // customer portal
  'portal.use': 'Use the customer portal',
  // platform (NEXUS staff)
  'platform.tenants': 'Manage tenants', 'platform.plans': 'Manage plans & pricing', 'platform.billing': 'View SaaS billing',
  'platform.support': 'Handle platform support', 'platform.config': 'Platform configuration', 'platform.audit': 'Platform audit logs',
} as const;

export type Permission = keyof typeof PERMISSIONS;
const all = Object.keys(PERMISSIONS) as Permission[];
const tenantAll = all.filter((p) => !p.startsWith('platform.') && p !== 'portal.use');
const without = (list: Permission[], ...ex: (Permission | RegExp)[]) =>
  list.filter((p) => !ex.some((e) => (typeof e === 'string' ? e === p : e.test(p))));

export const SYSTEM_ROLES: { key: string; name: string; scope: 'platform' | 'tenant' | 'customer'; description: string; permissions: Permission[] }[] = [
  { key: 'super_admin', name: 'Platform Super Admin', scope: 'platform', description: 'NEXUS platform operator. No tenant data access without a support grant.',
    permissions: all.filter((p) => p.startsWith('platform.')) },
  { key: 'owner', name: 'Business Owner', scope: 'tenant', description: 'Full access to all business modules', permissions: tenantAll },
  { key: 'admin', name: 'Business Administrator', scope: 'tenant', description: 'Administers the business except subscription',
    permissions: without(tenantAll, 'subscription.manage') },
  { key: 'branch_manager', name: 'Branch Manager', scope: 'tenant', description: 'Manages operations of a single branch',
    permissions: without(tenantAll, 'subscription.manage', 'settings.manage', 'integrations.manage', 'branches.manage', 'users.manage', 'privacy.manage', 'audit.read') },
  { key: 'operations_manager', name: 'Operations Manager', scope: 'tenant', description: 'Runs day-to-day operations',
    permissions: without(tenantAll, 'subscription.manage', 'settings.manage', 'integrations.manage', 'users.manage', 'branches.manage',
      'payments.refund', 'invoices.cancel', 'privacy.manage', 'audit.read') },
  { key: 'dispatcher', name: 'Dispatcher', scope: 'tenant', description: 'Schedules and assigns jobs',
    permissions: ['dashboard.view', 'customers.read', 'customers.create', 'customers.update', 'assets.read', 'assets.manage', 'requests.read', 'requests.create',
      'requests.review', 'work_orders.read', 'work_orders.create', 'work_orders.update', 'work_orders.assign', 'work_orders.status', 'technicians.read',
      'dispatch.manage', 'calendar.view', 'reports.operational', 'documents.read', 'documents.upload', 'ai.use', 'support.read', 'amc.read', 'inventory.read', 'communications.read'] },
  { key: 'technician', name: 'Technician', scope: 'tenant', description: 'Field technician; sees only own jobs',
    permissions: ['work_orders.read_own', 'work_orders.execute', 'documents.upload', 'inventory.read', 'ai.use'] },
  { key: 'accountant', name: 'Accountant', scope: 'tenant', description: 'Manages quotations, invoices and payments',
    permissions: ['dashboard.view', 'customers.read', 'customers.export', 'quotations.read', 'quotations.manage', 'invoices.read', 'invoices.manage', 'invoices.cancel',
      'payments.read', 'payments.record', 'payments.refund', 'payments.reconcile', 'reports.financial', 'reports.operational', 'amc.read', 'documents.read',
      'work_orders.read', 'inventory.read'] },
  { key: 'customer', name: 'Customer', scope: 'customer', description: 'Customer portal user', permissions: ['portal.use'] },
];
