-- T&T Engine Database Schema v3
-- PostgreSQL 15+
-- Multi-tenant, lifecycle-aware, convergent tokenization platform

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- ENUM: token lifecycle states
-- ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE token_status AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- token_store: encrypted values mapped to tokens, per tenant
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_store (
    token           TEXT            NOT NULL,
    value_encrypted TEXT            NOT NULL,
    transformation  TEXT            NOT NULL,
    key_version     INT             NOT NULL DEFAULT 1,
    tenant_id       TEXT            NOT NULL,
    status          token_status    NOT NULL DEFAULT 'ACTIVE',
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    CONSTRAINT pk_token_store PRIMARY KEY (token)
);

CREATE INDEX IF NOT EXISTS idx_token_store_tenant ON token_store (tenant_id);
CREATE INDEX IF NOT EXISTS idx_token_store_key_version ON token_store (key_version);
CREATE INDEX IF NOT EXISTS idx_token_store_status ON token_store (status) WHERE status != 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_token_store_expires ON token_store (expires_at)
    WHERE expires_at IS NOT NULL AND status = 'ACTIVE';

-- ─────────────────────────────────────────────────────────────────────
-- token_lookup: convergent tokenization index, per tenant
-- UNIQUE(hash, tenant_id) ensures deterministic tokenization within tenant
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_lookup (
    hash        TEXT    NOT NULL,
    tenant_id   TEXT    NOT NULL,
    token       TEXT    NOT NULL REFERENCES token_store(token) ON DELETE CASCADE,
    CONSTRAINT pk_token_lookup PRIMARY KEY (hash, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_token_lookup_token ON token_lookup (token);

-- ─────────────────────────────────────────────────────────────────────
-- request_dedup: idempotency layer
-- Stores hashed requests → cached responses for deduplication
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS request_dedup (
    request_hash    TEXT        NOT NULL,
    tenant_id       TEXT        NOT NULL,
    response_cache  JSONB       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pk_request_dedup PRIMARY KEY (request_hash, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_request_dedup_created ON request_dedup (created_at);

-- ─────────────────────────────────────────────────────────────────────
-- audit_log: immutable append-only audit trail, per tenant
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL       PRIMARY KEY,
    action       TEXT            NOT NULL,
    field        TEXT,
    tenant_id    TEXT            NOT NULL,
    trace_id     TEXT,
    status       TEXT            NOT NULL DEFAULT 'success',
    performed_at TIMESTAMPTZ     NOT NULL DEFAULT now(),
    metadata     JSONB           NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_performed_at ON audit_log (performed_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_trace_id ON audit_log (trace_id) WHERE trace_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- Trigger: auto-update updated_at
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_token_store_updated_at ON token_store;
CREATE TRIGGER trg_token_store_updated_at
    BEFORE UPDATE ON token_store
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────
-- Concurrency-safe tenant-aware upsert
-- Inserts new token OR returns existing winner token on conflict.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION upsert_token(
    p_token           TEXT,
    p_value_encrypted TEXT,
    p_transformation  TEXT,
    p_key_version     INT,
    p_hash            TEXT,
    p_tenant_id       TEXT,
    p_expires_at      TIMESTAMPTZ DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    v_existing_token TEXT;
BEGIN
    -- Insert token_store FIRST (parent table for FK)
    BEGIN
        INSERT INTO token_store (token, value_encrypted, transformation, key_version, tenant_id, expires_at)
        VALUES (p_token, p_value_encrypted, p_transformation, p_key_version, p_tenant_id, p_expires_at);
    EXCEPTION WHEN unique_violation THEN
        -- token already exists (rare race) — ignore
        NULL;
    END;

    -- Then attempt insert into lookup (the convergent contention point)
    INSERT INTO token_lookup (hash, tenant_id, token)
    VALUES (p_hash, p_tenant_id, p_token)
    ON CONFLICT (hash, tenant_id) DO NOTHING;

    IF FOUND THEN
        -- We won the race
        RETURN p_token;
    ELSE
        -- Another transaction won — return the existing token, clean up our token_store row
        SELECT token INTO v_existing_token
        FROM token_lookup WHERE hash = p_hash AND tenant_id = p_tenant_id;
        IF v_existing_token != p_token THEN
            DELETE FROM token_store WHERE token = p_token;
        END IF;
        RETURN v_existing_token;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────
-- Expire tokens whose expires_at has passed
-- Called by the background cleanup worker
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expire_stale_tokens(p_batch_size INT DEFAULT 1000)
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    WITH expired AS (
        SELECT token FROM token_store
        WHERE status = 'ACTIVE'
          AND expires_at IS NOT NULL
          AND expires_at < now()
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    )
    UPDATE token_store SET status = 'EXPIRED'
    FROM expired WHERE token_store.token = expired.token;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────
-- Cleanup old dedup entries
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cleanup_dedup(p_max_age INTERVAL DEFAULT '1 hour')
RETURNS INT AS $$
DECLARE
    v_count INT;
BEGIN
    DELETE FROM request_dedup WHERE created_at < now() - p_max_age;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────
-- transform_rules: Admin-manageable field classification + transform rules
-- Replaces hardcoded ClassificationRegistry defaults at runtime.
-- Seeded with the same 16 defaults on first boot; admins can CRUD via control plane.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transform_rules (
    id                  SERIAL          PRIMARY KEY,
    name                TEXT            NOT NULL UNIQUE,
    type                TEXT            NOT NULL CHECK (type IN ('fpe', 'masking', 'hash')),
    template            TEXT            NOT NULL DEFAULT '',
    tweak_source        TEXT            NOT NULL DEFAULT 'internal',
    allowed_roles       TEXT[]          NOT NULL DEFAULT '{"tnt-engine"}',
    classification      TEXT            NOT NULL CHECK (classification IN ('HIGH_SENSITIVE', 'MEDIUM', 'LOW', 'UNCLASSIFIED')),
    allowed_operations  TEXT[]          NOT NULL DEFAULT '{}',
    description         TEXT            NOT NULL DEFAULT '',
    retention_days      INT,
    is_active           BOOLEAN         NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transform_rules_classification ON transform_rules (classification) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_transform_rules_active ON transform_rules (is_active);

DROP TRIGGER IF EXISTS trg_transform_rules_updated_at ON transform_rules;
CREATE TRIGGER trg_transform_rules_updated_at
    BEFORE UPDATE ON transform_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Seed default rules (matches classification.py + masking.py defaults).
-- ON CONFLICT DO NOTHING so re-running schema is idempotent.
INSERT INTO transform_rules (name, type, template, tweak_source, allowed_roles, classification, allowed_operations, description) VALUES
  ('ssn',             'fpe',     '***-**-####',         'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Social Security Number'),
  ('tax_id',          'fpe',     '**-*******',          'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Tax Identification Number'),
  ('card',            'fpe',     '****-****-****-####',  'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Payment Card Number'),
  ('credit_card',     'fpe',     '****-****-****-####',  'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Credit Card Number'),
  ('bank_account',    'fpe',     '****####',            'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Bank Account Number'),
  ('passport',        'fpe',     '**#######',           'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                           'Passport Number'),
  ('email',           'masking', 'j***@domain',         'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Email Address'),
  ('phone',           'masking', '***-***-####',        'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Phone Number'),
  ('date_of_birth',   'masking', '####-**-**',          'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Date of Birth'),
  ('drivers_license', 'fpe',     '**######',            'supplied',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Driver''s License'),
  ('name',            'masking', 'J*** D***',           'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','Person Name'),
  ('first_name',      'masking', 'J***',                'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','First Name'),
  ('last_name',       'masking', 'D***',                'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','Last Name'),
  ('address',         'masking', '12*** Ma***',         'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','Street Address'),
  ('city',            'masking', 'Ne***',               'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','City'),
  ('zip_code',        'masking', '1****',               'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}','ZIP/Postal Code')
ON CONFLICT (name) DO NOTHING;

COMMIT;
