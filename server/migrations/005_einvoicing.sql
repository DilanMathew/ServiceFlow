-- Electronic invoicing: India GST e-invoice (IRN via IRP/GSP) and EU EN 16931 UBL (Peppol BIS 3.0 / XRechnung).

-- Provider credentials reuse the encrypted integrations table.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check
  CHECK (kind IN ('email','whatsapp','sms','payment','maps','ai','storage','einvoice','peppol'));

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS einvoice_auto boolean NOT NULL DEFAULT false,      -- register/send automatically when an invoice is issued
  ADD COLUMN IF NOT EXISTS peppol_id text,                                    -- seller electronic address "scheme:identifier", e.g. 0088:5790000435968
  ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS bank_iban text,
  ADD COLUMN IF NOT EXISTS bank_bic text;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS peppol_id text,                                    -- buyer electronic address "scheme:identifier"
  ADD COLUMN IF NOT EXISTS buyer_reference text;                              -- e.g. German Leitweg-ID (XRechnung BT-10)

ALTER TABLE tenant_settings ADD CONSTRAINT tenant_peppol_id_format CHECK (peppol_id IS NULL OR peppol_id ~ '^[0-9A-Z]{2,4}:[^\s]{1,200}$');
ALTER TABLE customers ADD CONSTRAINT customer_peppol_id_format CHECK (peppol_id IS NULL OR peppol_id ~ '^[0-9A-Z]{2,4}:[^\s]{1,200}$');

CREATE TABLE einvoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  credit_note_id uuid,
  scheme text NOT NULL CHECK (scheme IN ('IN_IRN','PEPPOL_BIS3','XRECHNUNG')),
  status text NOT NULL CHECK (status IN ('registered','sent','failed','cancelled')),
  mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  provider text NOT NULL,
  -- India IRP acknowledgement
  irn text, ack_no text, ack_date timestamptz, signed_invoice text, signed_qr text,
  -- EU transmission
  provider_ref text,
  payload text NOT NULL,                       -- the exact JSON/XML that was submitted
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz, cancel_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id)
);
-- At most one live registration/transmission per document and scheme.
CREATE UNIQUE INDEX einvoice_active_uq ON einvoice_documents (tenant_id, invoice_id, COALESCE(credit_note_id, '00000000-0000-0000-0000-000000000000'::uuid), scheme)
  WHERE status IN ('registered','sent');
CREATE UNIQUE INDEX einvoice_irn_uq ON einvoice_documents (tenant_id, irn) WHERE irn IS NOT NULL AND status = 'registered';
CREATE INDEX einvoice_invoice_idx ON einvoice_documents (tenant_id, invoice_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON einvoice_documents TO app_tenant;
ALTER TABLE einvoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einvoice_documents TO app_tenant USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
