-- Web push subscriptions and idempotent replay of offline technician actions.

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  failure_count int NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT push_endpoint_len CHECK (length(endpoint) <= 1000)
);
-- One row per browser endpoint; re-subscribing from another account moves it.
CREATE UNIQUE INDEX push_subscriptions_endpoint_uq ON push_subscriptions (endpoint);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (tenant_id, user_id);

-- Responses to mutating requests that carried an Idempotency-Key header (offline queue replays).
CREATE TABLE idempotent_requests (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  key text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status int NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, key),
  CONSTRAINT idem_key_len CHECK (length(key) BETWEEN 8 AND 100)
);
CREATE INDEX idempotent_requests_created_idx ON idempotent_requests (created_at);

-- Per-user UI language (NULL = follow tenant locale / browser).
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text CHECK (locale IS NULL OR locale ~ '^[a-z]{2}(-[A-Z]{2})?$');

-- Tenant isolation (same policy as 002_rls.sql)
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions, idempotent_requests TO app_tenant;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscriptions TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
ALTER TABLE idempotent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotent_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotent_requests TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
