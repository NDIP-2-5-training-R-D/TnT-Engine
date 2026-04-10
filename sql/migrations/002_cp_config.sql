-- Control-Plane configuration tables
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- Run: psql -U tnt tnt_engine < sql/migrations/002_cp_config.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- cp_field_classifications
-- PII field → sensitivity level + allowed operations
-- Replaces hardcoded CLASSIFICATION_MAP in classification.ts
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cp_field_classifications (
    field_name        VARCHAR(100) PRIMARY KEY,
    sensitivity_level VARCHAR(20)  NOT NULL CHECK (
        sensitivity_level IN ('HIGH_SENSITIVE', 'MEDIUM', 'LOW', 'UNCLASSIFIED')
    ),
    allowed_operations TEXT[]      NOT NULL DEFAULT '{}',
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: 16 canonical PII fields (mirrors governance/classification.py)
INSERT INTO cp_field_classifications (field_name, sensitivity_level, allowed_operations) VALUES
    ('ssn',             'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('card',            'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('credit_card',     'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('tax_id',          'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('bank_account',    'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('passport',        'HIGH_SENSITIVE', ARRAY['TOKENIZE']),
    ('email',           'MEDIUM',         ARRAY['TOKENIZE', 'MASK', 'HMAC']),
    ('phone',           'MEDIUM',         ARRAY['TOKENIZE', 'MASK', 'HMAC']),
    ('date_of_birth',   'MEDIUM',         ARRAY['TOKENIZE', 'MASK', 'HMAC']),
    ('drivers_license', 'MEDIUM',         ARRAY['TOKENIZE', 'MASK', 'HMAC']),
    ('name',            'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH']),
    ('first_name',      'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH']),
    ('last_name',       'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH']),
    ('address',         'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH']),
    ('city',            'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH']),
    ('zip_code',        'LOW',            ARRAY['TOKENIZE', 'MASK', 'HMAC', 'PASSTHROUGH'])
ON CONFLICT (field_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- cp_alert_thresholds
-- Warning/critical thresholds for key health metrics
-- Replaces hardcoded DEFAULT_THRESHOLDS in alert-store.ts
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cp_alert_thresholds (
    metric_name    VARCHAR(100) PRIMARY KEY,
    display_name   VARCHAR(100) NOT NULL,
    description    TEXT,
    metric_key     VARCHAR(100) NOT NULL,
    warning_value  NUMERIC      NOT NULL,
    critical_value NUMERIC      NOT NULL,
    unit           VARCHAR(20)  NOT NULL DEFAULT '',
    direction      VARCHAR(10)  NOT NULL DEFAULT 'above' CHECK (direction IN ('above', 'below')),
    enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed: 5 default thresholds
INSERT INTO cp_alert_thresholds
    (metric_name, display_name, description, metric_key, warning_value, critical_value, unit, direction, enabled)
VALUES
    ('error_rate_pct',    'Error Rate',      'HTTP 5xx error rate percentage',          'error_rate_pct',    1,   5,   '%',  'above', TRUE),
    ('latency_p99_ms',    'P99 Latency',     'Crypto operation P99 latency',            'crypto_latency_avg_ms', 100, 500, 'ms', 'above', TRUE),
    ('cache_hit_pct',     'Cache Hit Rate',  'Token cache hit percentage',              'cache_hit_rate',    70,  50,  '%',  'below', TRUE),
    ('audit_buffer_size', 'Audit Buffer',    'Pending audit entries in memory buffer',  'audit_buffer_size', 50,  200, '',   'above', TRUE),
    ('db_connections',    'DB Connections',  'Active database pool connections',        'active_connections',15,  19,  '',   'above', TRUE)
ON CONFLICT (metric_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- cp_backup_records
-- Metadata for each Vault/OpenBao Raft snapshot
-- Replaces file /tmp/tnt-backup-metadata.json (lost on pod restart)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cp_backup_records (
    id              VARCHAR(50)  PRIMARY KEY,
    triggered_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    size_bytes      BIGINT,
    checksum_sha256 VARCHAR(64),
    storage_location TEXT,
    status          VARCHAR(20)  NOT NULL CHECK (status IN ('completed', 'failed', 'verified', 'expired')),
    triggered_by    VARCHAR(100) NOT NULL DEFAULT 'manual',
    vault_version   VARCHAR(50),
    duration_ms     INT,
    error_detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_cp_backup_records_triggered_at
    ON cp_backup_records (triggered_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- cp_backup_schedule
-- Singleton row (id=1) — backup schedule configuration
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cp_backup_schedule (
    id               INT         PRIMARY KEY DEFAULT 1,
    enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
    interval_hours   INT         NOT NULL DEFAULT 4,
    retention_count  INT         NOT NULL DEFAULT 10,
    cron_expression  VARCHAR(50) NOT NULL DEFAULT '0 */4 * * *',
    last_run_at      TIMESTAMPTZ,
    last_run_status  VARCHAR(10) CHECK (last_run_status IN ('success', 'failed')),
    next_run_at      TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed: default schedule row
INSERT INTO cp_backup_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
