-- Row level security.
-- Tenant-scoped requests run inside a transaction that executes:
--     SET LOCAL ROLE app_tenant; SELECT set_config('app.tenant_id', '<uuid>', true);
-- app_tenant is NOT a superuser and does not own the tables, so FORCE'd policies always apply,
-- even when the connection itself is a superuser (as on managed Postgres such as Railway).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT app_tenant TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_tenant;

-- Platform-only tables: tenant role must never touch them (subscription_plans is read-only)
REVOKE ALL ON platform_settings, announcements, platform_ticket_messages, webhook_events,
  support_access_grants, subscription_invoices FROM app_tenant;
REVOKE INSERT, UPDATE, DELETE ON subscription_plans, permissions, tenants FROM app_tenant;
GRANT SELECT ON announcements TO app_tenant;
-- Audit log is append-only for the tenant role
REVOKE UPDATE, DELETE ON audit_logs FROM app_tenant;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- Strict isolation for every table that has a NOT NULL tenant_id
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = 'public' AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    -- the owner/system context (migrations, auth, platform admin, workers that set context explicitly) is unrestricted
    EXECUTE format('CREATE POLICY system_access ON %I TO PUBLIC USING (current_user <> ''app_tenant'') WITH CHECK (current_user <> ''app_tenant'')', t);
  END LOOP;
END $$;

-- Tables with nullable tenant_id (shared platform rows + tenant rows)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants TO app_tenant USING (id = current_tenant_id());
CREATE POLICY system_access ON tenants TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');
GRANT UPDATE (name, legal_name, email, phone, address_line1, address_line2, city, state, postal_code,
  country, business_category, employee_count, technician_count, logo_storage_key, updated_at) ON tenants TO app_tenant;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_access ON users TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON roles FOR SELECT TO app_tenant USING (tenant_id IS NULL OR tenant_id = current_tenant_id());
CREATE POLICY tenant_write ON roles FOR ALL TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_access ON roles TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_roles TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_access ON user_roles TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions TO app_tenant USING (tenant_id = current_tenant_id());
CREATE POLICY system_access ON sessions TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON notification_templates FOR SELECT TO app_tenant USING (tenant_id IS NULL OR tenant_id = current_tenant_id());
CREATE POLICY tenant_write ON notification_templates FOR ALL TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_access ON notification_templates TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit_logs FOR SELECT TO app_tenant USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_insert ON audit_logs FOR INSERT TO app_tenant WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY system_access ON audit_logs TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_insert ON background_jobs FOR INSERT TO app_tenant WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_read ON background_jobs FOR SELECT TO app_tenant USING (tenant_id = current_tenant_id());
CREATE POLICY system_access ON background_jobs TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');

-- Shared reference data
GRANT SELECT ON subscription_plans, permissions, role_permissions TO app_tenant;

-- Tenants may edit permissions of their own custom roles only; system roles are read-only.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON role_permissions FOR SELECT TO app_tenant
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND (r.tenant_id IS NULL OR r.tenant_id = current_tenant_id())));
CREATE POLICY tenant_write ON role_permissions FOR ALL TO app_tenant
  USING (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM roles r WHERE r.id = role_id AND r.tenant_id = current_tenant_id()));
CREATE POLICY system_access ON role_permissions TO PUBLIC USING (current_user <> 'app_tenant') WITH CHECK (current_user <> 'app_tenant');
