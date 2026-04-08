-- Migration: add transform_rules table
-- Run this against an existing database that was initialized before this table was added.
-- Idempotent: safe to run multiple times.

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

-- Auto-update updated_at (reuse existing trigger function)
DROP TRIGGER IF EXISTS trg_transform_rules_updated_at ON transform_rules;
CREATE TRIGGER trg_transform_rules_updated_at
    BEFORE UPDATE ON transform_rules
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Seed default rules (idempotent — skips existing names)
INSERT INTO transform_rules (name, type, template, tweak_source, allowed_roles, classification, allowed_operations, description) VALUES
  ('ssn',             'fpe',     '***-**-####',          'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Social Security Number'),
  ('tax_id',          'fpe',     '**-*******',           'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Tax Identification Number'),
  ('card',            'fpe',     '****-****-****-####',  'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Payment Card Number'),
  ('credit_card',     'fpe',     '****-****-****-####',  'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Credit Card Number'),
  ('bank_account',    'fpe',     '****####',             'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Bank Account Number'),
  ('passport',        'fpe',     '**#######',            'supplied',  '{"tnt-engine"}', 'HIGH_SENSITIVE', '{"TOKENIZE"}',                            'Passport Number'),
  ('email',           'masking', 'j***@domain',          'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Email Address'),
  ('phone',           'masking', '***-***-####',         'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Phone Number'),
  ('date_of_birth',   'masking', '####-**-**',           'internal',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Date of Birth'),
  ('drivers_license', 'fpe',     '**######',             'supplied',  '{"tnt-engine"}', 'MEDIUM',         '{"TOKENIZE","MASK","HMAC"}',              'Driver''s License'),
  ('name',            'masking', 'J*** D***',            'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'Person Name'),
  ('first_name',      'masking', 'J***',                 'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'First Name'),
  ('last_name',       'masking', 'D***',                 'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'Last Name'),
  ('address',         'masking', '12*** Ma***',          'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'Street Address'),
  ('city',            'masking', 'Ne***',                'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'City'),
  ('zip_code',        'masking', '1****',                'internal',  '{"tnt-engine"}', 'LOW',            '{"TOKENIZE","MASK","HMAC","PASSTHROUGH"}', 'ZIP/Postal Code')
ON CONFLICT (name) DO NOTHING;
