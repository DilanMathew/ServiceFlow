-- NEXUS ServiceFlow — core schema
-- Conventions:
--   * Every tenant-owned table has tenant_id NOT NULL and UNIQUE (tenant_id, id) so that
--     child tables reference parents through composite FKs (tenant_id, parent_id). This makes
--     it impossible at the database level to link a record to another tenant's record.
--   * Row level security (see 002_rls.sql) is FORCED on every tenant table.
--   * Money is numeric(14,2). Quantities are numeric(12,3).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- =========================================================================
-- PLATFORM (NEXUS) LEVEL
-- =========================================================================
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  currency text NOT NULL DEFAULT 'USD',
  monthly_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
  annual_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (annual_price >= 0),
  trial_days int NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
  max_users int,               -- NULL = unlimited
  max_technicians int,
  max_storage_mb int,
  max_branches int NOT NULL DEFAULT 1,
  ai_requests_per_month int NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '{}'::jsonb, -- { "quotations": true, "inventory": false, ... }
  is_public boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  legal_name text,
  email citext,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  country char(2) NOT NULL DEFAULT 'IN',
  business_category text,
  employee_count int,
  technician_count int,
  logo_storage_key text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  suspended_reason text,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- IDENTITY & ACCESS
-- =========================================================================
CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  phone text,
  email citext,
  address_line1 text, city text, state text, postal_code text, country char(2),
  is_headquarters boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE, -- NULL only for platform staff
  branch_id uuid,
  email citext NOT NULL,
  password_hash text,
  full_name text NOT NULL,
  phone text,
  avatar_storage_key text,
  user_type text NOT NULL CHECK (user_type IN ('platform','staff','customer')),
  is_active boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  locale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  CHECK ((user_type = 'platform') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX users_email_tenant_uq ON users (tenant_id, email) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX users_email_platform_uq ON users (email) WHERE tenant_id IS NULL;
CREATE INDEX users_email_idx ON users (email);

CREATE TABLE permissions (
  code text PRIMARY KEY,           -- e.g. 'work_orders.assign'
  module text NOT NULL,
  description text NOT NULL
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = system role template
  key text NOT NULL,
  name text NOT NULL,
  description text,
  scope text NOT NULL CHECK (scope IN ('platform','tenant','customer')),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_key_uq ON roles (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  previous_token_hash text,          -- for refresh-token reuse detection
  ip inet,
  user_agent text,
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  support_access_grant_id uuid
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset','invitation','mfa_challenge')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Super Admin cannot read tenant data unless the tenant grants time-boxed support access.
CREATE TABLE support_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  granted_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- TENANT CONFIGURATION
-- =========================================================================
CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  currency char(3) NOT NULL DEFAULT 'INR',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  locale text NOT NULL DEFAULT 'en-IN',
  date_format text NOT NULL DEFAULT 'dd MMM yyyy',
  tax_regime text NOT NULL DEFAULT 'GST' CHECK (tax_regime IN ('GST','VAT','SALES_TAX','NONE')),
  tax_registration_number text,       -- GSTIN / VAT number
  tax_registration_label text NOT NULL DEFAULT 'GSTIN',
  prices_include_tax boolean NOT NULL DEFAULT false,
  working_days int[] NOT NULL DEFAULT '{1,2,3,4,5,6}', -- ISO: 1=Mon .. 7=Sun
  working_hours_start time NOT NULL DEFAULT '09:00',
  working_hours_end time NOT NULL DEFAULT '18:00',
  job_number_prefix text NOT NULL DEFAULT 'JOB-',
  invoice_number_prefix text NOT NULL DEFAULT 'INV-',
  quotation_number_prefix text NOT NULL DEFAULT 'QUO-',
  request_number_prefix text NOT NULL DEFAULT 'SR-',
  amc_number_prefix text NOT NULL DEFAULT 'AMC-',
  customer_number_prefix text NOT NULL DEFAULT 'CUS-',
  asset_number_prefix text NOT NULL DEFAULT 'AST-',
  ticket_number_prefix text NOT NULL DEFAULT 'TKT-',
  credit_note_prefix text NOT NULL DEFAULT 'CN-',
  payment_terms_days int NOT NULL DEFAULT 15 CHECK (payment_terms_days BETWEEN 0 AND 365),
  quotation_validity_days int NOT NULL DEFAULT 30,
  invoice_footer text,
  quotation_terms text,
  cancellation_policy text,
  cancellation_notice_hours int NOT NULL DEFAULT 24,
  prevent_double_booking boolean NOT NULL DEFAULT true,
  inventory_enabled boolean NOT NULL DEFAULT true,
  technician_can_see_prices boolean NOT NULL DEFAULT false,
  location_tracking_enabled boolean NOT NULL DEFAULT false,
  public_request_form_enabled boolean NOT NULL DEFAULT true,
  notification_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_retention_days int,
  onboarding_step int NOT NULL DEFAULT 0,
  onboarding_completed_at timestamptz,
  brand_color text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  counter text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, counter)
);

CREATE TABLE holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date date NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, date)
);

CREATE TABLE tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,                  -- "GST 18%", "VAT 21%"
  rate numeric(6,3) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  components jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{"name":"CGST","rate":9},{"name":"SGST","rate":9}]
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE service_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  name text NOT NULL,
  postal_codes text[] NOT NULL DEFAULT '{}',
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  default_duration_minutes int NOT NULL DEFAULT 60 CHECK (default_duration_minutes > 0),
  default_price numeric(14,2),
  color text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE equipment_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  maintenance_interval_days int,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- =========================================================================
-- CRM
-- =========================================================================
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text NOT NULL,
  customer_type text NOT NULL DEFAULT 'individual' CHECK (customer_type IN ('individual','business')),
  full_name text NOT NULL,
  company_name text,
  email citext,
  phone text,
  phone_normalized text,
  alt_phone text,
  tax_id text,
  billing_line1 text, billing_line2 text, billing_city text, billing_state text,
  billing_postal_code text, billing_country char(2),
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  source text,
  portal_user_id uuid,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  notification_opt_out jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"whatsapp":true}
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  anonymized_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, portal_user_id) REFERENCES users(tenant_id, id)
);
-- Duplicate prevention: one active customer per email / phone per tenant.
CREATE UNIQUE INDEX customers_email_uq ON customers (tenant_id, email) WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone_normalized) WHERE phone_normalized IS NOT NULL AND archived_at IS NULL;
CREATE INDEX customers_name_idx ON customers (tenant_id, lower(full_name));
CREATE INDEX customers_created_idx ON customers (tenant_id, created_at DESC);

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  label text NOT NULL DEFAULT 'Primary',
  line1 text NOT NULL,
  line2 text,
  city text,
  state text,
  postal_code text,
  country char(2),
  latitude numeric(9,6),
  longitude numeric(9,6),
  access_notes text,
  service_area_id uuid,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_area_id) REFERENCES service_areas(tenant_id, id)
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (tenant_id, customer_id);

CREATE TABLE communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms','phone','in_person','note')),
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
  subject text,
  body text NOT NULL,
  user_id uuid,
  notification_log_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX communications_customer_idx ON communications (tenant_id, customer_id, created_at DESC);

-- =========================================================================
-- ASSETS
-- =========================================================================
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number text NOT NULL,
  customer_id uuid NOT NULL,
  address_id uuid,
  equipment_category_id uuid,
  name text NOT NULL,
  manufacturer text,
  model text,
  serial_number text,
  capacity text,
  installation_date date,
  purchase_date date,
  warranty_start date,
  warranty_expiry date,
  last_service_date date,
  next_service_due date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','under_repair','inactive','replaced','decommissioned')),
  replaced_by_asset_id uuid,
  replacement_reason text,
  notes text,
  qr_token text NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  UNIQUE (qr_token),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES customer_addresses(tenant_id, id),
  FOREIGN KEY (tenant_id, equipment_category_id) REFERENCES equipment_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, replaced_by_asset_id) REFERENCES assets(tenant_id, id),
  CHECK (warranty_expiry IS NULL OR warranty_start IS NULL OR warranty_expiry >= warranty_start)
);
CREATE UNIQUE INDEX assets_serial_uq ON assets (tenant_id, manufacturer, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX assets_customer_idx ON assets (tenant_id, customer_id);
CREATE INDEX assets_warranty_idx ON assets (tenant_id, warranty_expiry);

-- =========================================================================
-- TECHNICIANS
-- =========================================================================
CREATE TABLE technician_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  branch_id uuid,
  employee_id text,
  employment_status text NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active','on_leave','inactive','terminated')),
  employment_type text NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time','part_time','contractor')),
  hourly_cost numeric(14,2),
  max_jobs_per_day int NOT NULL DEFAULT 6 CHECK (max_jobs_per_day > 0),
  home_latitude numeric(9,6),
  home_longitude numeric(9,6),
  bio text,
  location_sharing_consent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, employee_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

CREATE TABLE technician_skills (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL,
  service_category_id uuid NOT NULL,
  proficiency smallint NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
  certified_until date,
  PRIMARY KEY (technician_id, service_category_id),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_category_id) REFERENCES service_categories(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE technician_service_areas (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL,
  service_area_id uuid NOT NULL,
  PRIMARY KEY (technician_id, service_area_id),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_area_id) REFERENCES service_areas(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE technician_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE (technician_id, weekday, start_time),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE technician_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE technician_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  technician_id uuid NOT NULL,
  work_date date NOT NULL,
  check_in_at timestamptz,
  check_out_at timestamptz,
  notes text,
  UNIQUE (technician_id, work_date),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id) ON DELETE CASCADE
);

-- =========================================================================
-- SERVICE REQUESTS & WORK ORDERS
-- =========================================================================
CREATE TABLE service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text NOT NULL,
  customer_id uuid,
  address_id uuid,
  asset_id uuid,
  service_category_id uuid,
  contact_name text NOT NULL,
  contact_phone text,
  contact_email citext,
  address_text text,
  description text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  preferred_date date,
  preferred_time_slot text CHECK (preferred_time_slot IN ('morning','afternoon','evening','any')),
  source text NOT NULL CHECK (source IN ('portal','admin','public_form','whatsapp','phone','email','ai_assistant')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','under_review','approved','rejected','converted','cancelled')),
  rejection_reason text,
  ai_analysis jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  work_order_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES customer_addresses(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, service_category_id) REFERENCES service_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX service_requests_status_idx ON service_requests (tenant_id, status, created_at DESC);

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text NOT NULL,
  customer_id uuid NOT NULL,
  address_id uuid,
  asset_id uuid,
  service_category_id uuid,
  service_request_id uuid,
  amc_visit_id uuid,
  title text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','approved','scheduled','assigned','en_route','in_progress','on_hold','completed','invoiced','paid','cancelled','rejected')),
  scheduled_start timestamptz,
  expected_duration_minutes int NOT NULL DEFAULT 60 CHECK (expected_duration_minutes > 0),
  actual_start timestamptz,
  actual_end timestamptz,
  assigned_technician_id uuid,
  internal_notes text,
  customer_notes text,
  estimated_cost numeric(14,2),
  actual_cost numeric(14,2),
  hold_reason text,
  cancellation_reason text,
  reschedule_count int NOT NULL DEFAULT 0,
  accepted_at timestamptz,
  completed_by uuid,
  created_by uuid,
  version int NOT NULL DEFAULT 1,           -- optimistic concurrency
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES customer_addresses(tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id),
  FOREIGN KEY (tenant_id, service_category_id) REFERENCES service_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, service_request_id) REFERENCES service_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_technician_id) REFERENCES technician_profiles(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX work_orders_status_idx ON work_orders (tenant_id, status);
CREATE INDEX work_orders_schedule_idx ON work_orders (tenant_id, scheduled_start);
CREATE INDEX work_orders_tech_idx ON work_orders (tenant_id, assigned_technician_id, scheduled_start);
CREATE INDEX work_orders_customer_idx ON work_orders (tenant_id, customer_id);
CREATE UNIQUE INDEX work_orders_request_uq ON work_orders (tenant_id, service_request_id) WHERE service_request_id IS NOT NULL;

ALTER TABLE service_requests ADD FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id);

-- Assignment history. The exclusion constraint makes double-booking impossible even under
-- concurrent requests, when the tenant enables the restriction (enforce_no_overlap = true).
CREATE TABLE job_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  technician_id uuid NOT NULL,
  time_window tstzrange NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  enforce_no_overlap boolean NOT NULL DEFAULT true,
  assigned_by uuid,
  assignment_source text NOT NULL DEFAULT 'manual' CHECK (assignment_source IN ('manual','suggestion','ai_suggestion','technician_self')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id),
  EXCLUDE USING gist (tenant_id WITH =, technician_id WITH =, time_window WITH &&)
    WHERE (is_current AND enforce_no_overlap)
);
CREATE UNIQUE INDEX job_assignments_current_uq ON job_assignments (work_order_id) WHERE is_current;
CREATE INDEX job_assignments_tech_idx ON job_assignments (tenant_id, technician_id) WHERE is_current;

CREATE TABLE work_order_status_history (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX wo_history_idx ON work_order_status_history (tenant_id, work_order_id, changed_at);

CREATE TABLE work_order_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  author_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','customer')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE work_order_labour (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  technician_id uuid,
  description text NOT NULL,
  hours numeric(8,2) NOT NULL CHECK (hours > 0),
  rate numeric(14,2) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE service_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  reported_issue text,
  findings text,
  work_performed text,
  recommendations text,
  follow_up_required boolean NOT NULL DEFAULT false,
  follow_up_notes text,
  equipment_condition text CHECK (equipment_condition IN ('good','fair','poor','critical')),
  technician_notes text,
  ai_generated boolean NOT NULL DEFAULT false,
  customer_signed_name text,
  customer_signature_document_id uuid,
  customer_approved_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, work_order_id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
);

-- =========================================================================
-- INVENTORY
-- =========================================================================
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  contact_name text, email citext, phone text, address text, tax_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  name text NOT NULL,
  location_type text NOT NULL DEFAULT 'warehouse' CHECK (location_type IN ('warehouse','van','store')),
  technician_id uuid,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id)
);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku text NOT NULL,
  name text NOT NULL,
  category text,
  description text,
  unit text NOT NULL DEFAULT 'pcs',
  purchase_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  tax_rate_id uuid,
  min_stock numeric(12,3) NOT NULL DEFAULT 0,
  supplier_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, tax_rate_id) REFERENCES tax_rates(tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id)
);

CREATE TABLE inventory_stock (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0), -- never negative
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_locations(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE purchase_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id uuid,
  location_id uuid NOT NULL,
  reference text,
  purchase_date date NOT NULL DEFAULT current_date,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_locations(tenant_id, id)
);

CREATE TABLE purchase_record_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_record_id uuid NOT NULL,
  item_id uuid NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  FOREIGN KEY (tenant_id, purchase_record_id) REFERENCES purchase_records(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id)
);

CREATE TABLE inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  location_id uuid NOT NULL,
  txn_type text NOT NULL CHECK (txn_type IN ('purchase','adjustment','job_usage','job_return','transfer_in','transfer_out','opening')),
  quantity_change numeric(12,3) NOT NULL CHECK (quantity_change <> 0),
  quantity_after numeric(12,3) NOT NULL,
  unit_cost numeric(14,2),
  reference_type text,
  reference_id uuid,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_locations(tenant_id, id)
);
CREATE INDEX inventory_txn_item_idx ON inventory_transactions (tenant_id, item_id, created_at DESC);

CREATE TABLE work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  item_id uuid,
  location_id uuid,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  unit_cost numeric(14,2),
  inventory_txn_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES stock_locations(tenant_id, id)
);

-- =========================================================================
-- QUOTATIONS
-- =========================================================================
CREATE TABLE quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text NOT NULL,
  revision int NOT NULL DEFAULT 1,
  root_quotation_id uuid,             -- first quotation in the revision chain
  previous_revision_id uuid,
  customer_id uuid NOT NULL,
  work_order_id uuid,
  amc_contract_id uuid,
  title text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','viewed','approved','rejected','expired','superseded','converted')),
  currency char(3) NOT NULL,
  issue_date date NOT NULL DEFAULT current_date,
  valid_until date NOT NULL,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  tax_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  terms text,
  public_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  sent_at timestamptz, viewed_at timestamptz,
  approved_at timestamptz, approved_by_name text,
  rejected_at timestamptz, rejection_reason text,
  revision_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number, revision),
  UNIQUE (public_token),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, previous_revision_id) REFERENCES quotations(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX quotations_status_idx ON quotations (tenant_id, status);
CREATE INDEX quotations_customer_idx ON quotations (tenant_id, customer_id);

CREATE TABLE quotation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  quotation_id uuid NOT NULL,
  position int NOT NULL DEFAULT 0,
  item_type text NOT NULL CHECK (item_type IN ('labour','part','charge')),
  inventory_item_id uuid,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  tax_rate_id uuid,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  tax_components jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_subtotal numeric(14,2) NOT NULL,
  line_discount numeric(14,2) NOT NULL,
  line_tax numeric(14,2) NOT NULL,
  line_total numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES quotations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_rate_id) REFERENCES tax_rates(tenant_id, id)
);

-- =========================================================================
-- INVOICES, PAYMENTS, REFUNDS
-- =========================================================================
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text,                         -- assigned at issue time (gapless per tenant)
  customer_id uuid NOT NULL,
  work_order_id uuid,
  quotation_id uuid,
  amc_contract_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','partially_paid','paid','overdue','cancelled','refunded','partially_refunded')),
  currency char(3) NOT NULL,
  issue_date date,
  due_date date,
  -- Snapshots so that an issued invoice never changes if customer/business data changes later
  bill_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  seller jsonb NOT NULL DEFAULT '{}'::jsonb,
  place_of_supply text,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  discount_total numeric(14,2) NOT NULL DEFAULT 0,
  tax_total numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  tax_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  amount_refunded numeric(14,2) NOT NULL DEFAULT 0,
  amount_credited numeric(14,2) NOT NULL DEFAULT 0,
  balance_due numeric(14,2) GENERATED ALWAYS AS (total - amount_paid - amount_credited) STORED, -- refunds are tracked separately and never re-open a receivable
  notes text,
  footer text,
  public_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  issued_at timestamptz, issued_by uuid,
  cancelled_at timestamptz, cancellation_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (public_token),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES quotations(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  CHECK (amount_paid >= 0 AND amount_refunded >= 0 AND amount_refunded <= amount_paid),
  CHECK (status = 'draft' OR number IS NOT NULL)
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices (tenant_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoices_status_idx ON invoices (tenant_id, status, due_date);
CREATE INDEX invoices_customer_idx ON invoices (tenant_id, customer_id);
-- An approved quotation can be converted into at most one live invoice
CREATE UNIQUE INDEX invoices_quotation_uq ON invoices (tenant_id, quotation_id) WHERE quotation_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  position int NOT NULL DEFAULT 0,
  item_type text NOT NULL CHECK (item_type IN ('labour','part','charge','amc')),
  inventory_item_id uuid,
  description text NOT NULL,
  hsn_sac_code text,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  tax_rate_id uuid,
  tax_rate numeric(6,3) NOT NULL DEFAULT 0,
  tax_components jsonb NOT NULL DEFAULT '[]'::jsonb,
  line_subtotal numeric(14,2) NOT NULL,
  line_discount numeric(14,2) NOT NULL,
  line_tax numeric(14,2) NOT NULL,
  line_total numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_rate_id) REFERENCES tax_rates(tenant_id, id)
);

CREATE TABLE credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  number text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

-- Online checkout attempts with the tenant's own payment gateway
CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  provider text NOT NULL,
  provider_order_id text NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','succeeded','failed','expired')),
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (provider, provider_order_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  receipt_number text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','bank_transfer','card','upi','cheque','gateway','other')),
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  provider text,
  provider_payment_id text,
  payment_intent_id uuid,
  reference text,
  failure_reason text,
  idempotency_key text,
  received_at timestamptz NOT NULL DEFAULT now(),
  reconciled_at timestamptz,
  reconciled_by uuid,
  notes text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES payment_intents(tenant_id, id)
);
-- Duplicate payment prevention
CREATE UNIQUE INDEX payments_provider_uq ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_idem_uq ON payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX payments_receipt_uq ON payments (tenant_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX payments_invoice_idx ON payments (tenant_id, invoice_id);
CREATE INDEX payments_received_idx ON payments (tenant_id, received_at DESC);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  reason text NOT NULL,
  provider_refund_id text,
  idempotency_key text NOT NULL,
  failure_reason text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id)
);
CREATE UNIQUE INDEX refunds_provider_uq ON refunds (provider_refund_id) WHERE provider_refund_id IS NOT NULL;

-- Inbound webhook ledger (both tenant gateways and NEXUS subscription billing)
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  signature_valid boolean NOT NULL,
  processed_at timestamptz,
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- =========================================================================
-- AMC CONTRACTS
-- =========================================================================
CREATE TABLE amc_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid,
  number text NOT NULL,
  customer_id uuid NOT NULL,
  address_id uuid,
  service_category_id uuid,
  title text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('monthly','quarterly','half_yearly','annual')),
  visits_included int NOT NULL CHECK (visits_included > 0),
  contract_value numeric(14,2) NOT NULL CHECK (contract_value >= 0),
  currency char(3) NOT NULL,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partially_paid','paid')),
  coverage text,
  exclusions text,
  auto_renew boolean NOT NULL DEFAULT false,
  renewal_reminder_days int NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','expired','cancelled','renewed')),
  renewed_from_id uuid,
  renewal_reminder_sent_at timestamptz,
  cancelled_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  CHECK (end_date > start_date),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, address_id) REFERENCES customer_addresses(tenant_id, id),
  FOREIGN KEY (tenant_id, service_category_id) REFERENCES service_categories(tenant_id, id),
  FOREIGN KEY (tenant_id, renewed_from_id) REFERENCES amc_contracts(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX amc_end_idx ON amc_contracts (tenant_id, status, end_date);

ALTER TABLE quotations ADD FOREIGN KEY (tenant_id, amc_contract_id) REFERENCES amc_contracts(tenant_id, id);
ALTER TABLE invoices ADD FOREIGN KEY (tenant_id, amc_contract_id) REFERENCES amc_contracts(tenant_id, id);

CREATE TABLE amc_contract_assets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  PRIMARY KEY (contract_id, asset_id),
  FOREIGN KEY (tenant_id, contract_id) REFERENCES amc_contracts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, asset_id) REFERENCES assets(tenant_id, id)
);

CREATE TABLE scheduled_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  visit_number int NOT NULL CHECK (visit_number > 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','work_order_created','completed','missed','cancelled')),
  work_order_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (contract_id, visit_number),     -- duplicate visit generation is impossible
  FOREIGN KEY (tenant_id, contract_id) REFERENCES amc_contracts(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id)
);
CREATE INDEX scheduled_visits_due_idx ON scheduled_visits (tenant_id, status, due_date);
ALTER TABLE work_orders ADD FOREIGN KEY (tenant_id, amc_visit_id) REFERENCES scheduled_visits(tenant_id, id);

-- =========================================================================
-- FEEDBACK & SUPPORT
-- =========================================================================
CREATE TABLE customer_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  work_order_id uuid,
  technician_id uuid,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  technician_rating smallint CHECK (technician_rating BETWEEN 1 AND 5),
  comment text,
  is_complaint boolean NOT NULL DEFAULT false,
  complaint_category text,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','reviewed','action_taken','dismissed')),
  corrective_action text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, technician_id) REFERENCES technician_profiles(tenant_id, id)
);
CREATE UNIQUE INDEX feedback_work_order_uq ON customer_feedback (tenant_id, work_order_id) WHERE work_order_id IS NOT NULL;

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number text NOT NULL,
  customer_id uuid,
  work_order_id uuid,
  feedback_id uuid,
  subject text NOT NULL,
  category text NOT NULL DEFAULT 'general' CHECK (category IN ('general','complaint','billing','service_quality','technician','scheduling','other')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_for_customer','resolved','closed')),
  assigned_to uuid,
  resolution text,
  resolved_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES users(tenant_id, id)
);

CREATE TABLE ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  author_id uuid,
  author_type text NOT NULL CHECK (author_type IN ('staff','customer','system')),
  is_internal boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES support_tickets(tenant_id, id) ON DELETE CASCADE
);

-- Tickets raised by tenants to NEXUS (platform support)
CREATE TABLE platform_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject text NOT NULL,
  body text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting_for_customer','resolved','closed')),
  created_by uuid,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES platform_tickets(id) ON DELETE CASCADE,
  author_id uuid,
  author_side text NOT NULL CHECK (author_side IN ('tenant','platform')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- DOCUMENTS
-- =========================================================================
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('customer','asset','work_order','service_request','quotation','invoice','amc_contract','support_ticket','technician','tenant','payment')),
  entity_id uuid NOT NULL,
  category text NOT NULL DEFAULT 'attachment' CHECK (category IN ('photo_before','photo_after','service_photo','equipment_document','warranty_certificate','quotation','invoice','contract','service_report','signature','customer_attachment','attachment','logo','receipt')),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,     -- random, never derived from user input
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','customer')),
  uploaded_by uuid,
  retain_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX documents_entity_idx ON documents (tenant_id, entity_type, entity_id) WHERE deleted_at IS NULL;

-- =========================================================================
-- NOTIFICATIONS & BACKGROUND JOBS
-- =========================================================================
CREATE TABLE notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform default
  event text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp','sms','in_app')),
  subject text,
  body text NOT NULL,
  whatsapp_template_name text,     -- pre-approved Meta template name
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notification_templates_uq ON notification_templates (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), event, channel);

CREATE TABLE notifications (           -- in-app inbox
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event text NOT NULL,
  title text NOT NULL,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);

CREATE TABLE notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event text NOT NULL,
  channel text NOT NULL,
  recipient text NOT NULL,
  customer_id uuid,
  user_id uuid,
  entity_type text,
  entity_id uuid,
  subject text,
  body text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','delivered','failed','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  provider text,
  provider_message_id text,
  dedupe_key text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_logs_status_idx ON notification_logs (tenant_id, status, created_at DESC);
CREATE UNIQUE INDEX notification_logs_dedupe_uq ON notification_logs (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Durable job queue (workers claim with FOR UPDATE SKIP LOCKED). Enqueued in the same
-- transaction as the business change, so a job exists iff the change committed.
CREATE TABLE background_jobs (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  queue text NOT NULL DEFAULT 'default',
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','dead')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX background_jobs_ready_idx ON background_jobs (status, run_at) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX background_jobs_dedupe_uq ON background_jobs (job_type, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- =========================================================================
-- SAAS SUBSCRIPTIONS (tenant -> NEXUS). Separate from tenant's own customer payments.
-- =========================================================================
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL CHECK (status IN ('trialing','active','past_due','grace_period','cancelled','expired','suspended')),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','annual')),
  price numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'USD',
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL,
  grace_period_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  pending_plan_id uuid REFERENCES subscription_plans(id),  -- scheduled downgrade
  provider text,
  provider_subscription_id text UNIQUE,
  custom_limits jsonb NOT NULL DEFAULT '{}'::jsonb,          -- enterprise overrides
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,   -- trial_started, activated, renewed, upgraded, downgraded, payment_failed, grace_started, cancelled, suspended, reactivated
  from_plan_id uuid,
  to_plan_id uuid,
  amount numeric(14,2),
  currency char(3),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_idx ON subscription_events (tenant_id, created_at DESC);

CREATE TABLE subscription_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  number text NOT NULL UNIQUE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount numeric(14,2) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('open','paid','failed','void')),
  provider_invoice_id text UNIQUE,
  paid_at timestamptz,
  failure_reason text,
  attempt_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =========================================================================
-- INTEGRATIONS, AI, AUDIT
-- =========================================================================
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email','whatsapp','sms','payment','maps','ai','storage')),
  provider text NOT NULL,
  mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,     -- non-secret settings
  secrets_encrypted text,                         -- AES-256-GCM, never returned by the API
  is_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('unconfigured','ok','error')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind)
);

CREATE TABLE ai_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid,
  feature text NOT NULL CHECK (feature IN ('request_interpretation','report_generation','scheduling','insights','support_assistant')),
  provider text NOT NULL,
  model text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  latency_ms int,
  status text NOT NULL CHECK (status IN ('success','error','rate_limited','disabled')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_tenant_idx ON ai_usage_logs (tenant_id, created_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid,
  user_email text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  ip inet,
  user_agent text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);

-- Audit log is append-only for everyone, including the application owner role.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Data subject requests (GDPR-oriented workflows)
CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('export','rectification','erasure')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','rejected')),
  notes text,
  result_document_id uuid,
  requested_by uuid,
  completed_by uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

-- =========================================================================
-- IMMUTABILITY OF ISSUED FINANCIAL DOCUMENTS
-- =========================================================================
CREATE OR REPLACE FUNCTION guard_invoice_items() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Invoice items cannot be modified after issue (status=%)', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION guard_invoice_items();

CREATE OR REPLACE FUNCTION guard_invoice_header() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
      NEW.subtotal IS DISTINCT FROM OLD.subtotal OR NEW.total IS DISTINCT FROM OLD.total OR
      NEW.tax_total IS DISTINCT FROM OLD.tax_total OR NEW.discount_total IS DISTINCT FROM OLD.discount_total OR
      NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.number IS DISTINCT FROM OLD.number OR
      NEW.bill_to IS DISTINCT FROM OLD.bill_to OR NEW.issue_date IS DISTINCT FROM OLD.issue_date OR
      NEW.currency IS DISTINCT FROM OLD.currency) THEN
    RAISE EXCEPTION 'Issued invoice % cannot be modified; use a credit note or cancellation', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Issued invoice cannot return to draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_guard BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_header();

CREATE OR REPLACE FUNCTION guard_quotation_items() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM quotations WHERE id = COALESCE(NEW.quotation_id, OLD.quotation_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Quotation items cannot be modified unless the quotation is a draft (status=%)', st USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER quotation_items_guard BEFORE INSERT OR UPDATE OR DELETE ON quotation_items
  FOR EACH ROW EXECUTE FUNCTION guard_quotation_items();

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;
