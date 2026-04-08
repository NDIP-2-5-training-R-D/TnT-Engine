// T&T Control Plane — Shared TypeScript interfaces
// These types represent the SAFE subset of data returned by BFF API routes.
// No secrets, tokens, or internal topology info is included.

// ── Health & Metrics ───────────────────────────────────────────────

export type VaultStatus = "healthy" | "sealed" | "standby" | "uninitialized" | "unreachable";

export interface HealthData {
  vault: {
    status: VaultStatus;
    initialized: boolean;
    sealed: boolean;
    version: string;
  };
  engine: {
    status: string;
    circuit_breaker: string;
    l1_cache_size: number;
  };
  postgres: { connected: boolean };
  redis: { connected: boolean };
  timestamp: string;
}

export interface MetricsData {
  crypto_latency: MetricPoint[];
  token_throughput: MetricPoint[];
  error_rate: MetricPoint[];
  cache_hit_rate: number;
  total_tokens_created: number;
  active_connections: number;
}

export interface MetricPoint {
  time: string;
  value: number;
}

// ── Audit ──────────────────────────────────────────────────────────

export interface AuditEntry {
  id: number;
  action: string;
  field: string | null;
  tenant_id: string;
  trace_id: string | null;
  status: string;
  performed_at: string;
}

// ── Key Lifecycle Management ───────────────────────────────────────

export interface TransitKeyInfo {
  name: string;
  type: string;
  latest_version: number;
  min_decryption_version: number;
  min_encryption_version: number;
  supports_encryption: boolean;
  supports_decryption: boolean;
  supports_signing: boolean;
  deletion_allowed: boolean;
  auto_rotate_period: number;
  // NEVER includes key material, nonce, or cryptographic values
}

export interface RotateResponse {
  success: boolean;
  message: string;
  new_version?: number;
}

// ── Policies ───────────────────────────────────────────────────────

export interface PolicyInfo {
  name: string;
  rules: string; // HCL text (for display only — no secrets)
}

export interface PolicyListItem {
  name: string;
}

export interface PolicySaveRequest {
  name: string;
  capabilities: PolicyCapability[];
}

export interface PolicyCapability {
  path: string;
  capabilities: string[];
}

// ── AppRole Provisioning ───────────────────────────────────────────

export interface AppRoleInfo {
  role_name: string;
  token_ttl: number;
  token_max_ttl: number;
  token_policies: string[];
  bind_secret_id: boolean;
  secret_id_num_uses: number;
}

export interface SecretIdResponse {
  secret_id: string; // Displayed ONCE then masked
  secret_id_accessor: string;
}

// ── Transform Rules ────────────────────────────────────────────────

export type SensitivityLevel = "HIGH_SENSITIVE" | "MEDIUM" | "LOW" | "UNCLASSIFIED";

export interface TransformRule {
  name: string;
  type: "fpe" | "masking" | "hash";
  template: string;
  tweak_source: string;
  allowed_roles: string[];
  classification: SensitivityLevel;
  allowed_operations: string[];
  description: string;
}

export interface TransformRulesResponse {
  rules: TransformRule[];
  source: "live" | "fallback";
  fetched_at: string;
}

// ── Playground ─────────────────────────────────────────────────────

/** Const object so values can be used as type-safe keys without magic strings. */
export const PlaygroundOp = {
  TOKENIZE:      "TOKENIZE",
  MASK:          "MASK",
  HMAC:          "HMAC",
  DETOKENIZE:    "DETOKENIZE",
  HMAC_SHA512:   "HMAC_SHA512",
  AES256_GCM96:  "AES256_GCM96",
  FF3_1:         "FF3_1",
  MASK_TEMPLATE: "MASK_TEMPLATE",
} as const;

export type PlaygroundOperation = (typeof PlaygroundOp)[keyof typeof PlaygroundOp];

/** Extra request body field required by some operations. Key = operation value. */
export const OPERATION_EXTRA_FIELD: Partial<Record<PlaygroundOperation, string>> = {
  [PlaygroundOp.MASK_TEMPLATE]: "mask_template",
};

export interface PlaygroundResult {
  operation: PlaygroundOperation;
  field_type: string;
  output_value: string;
  cached: boolean;
  classification: SensitivityLevel;
  allowed_operations: string[];
  latency_ms: number;
  trace_id: string | null;
  sandbox: true;
  raw_request: Record<string, unknown>;
  raw_response: Record<string, unknown>;
  error?: string;
}

// ── Shared ─────────────────────────────────────────────────────────

export interface SealResponse {
  success: boolean;
  message: string;
  sealed: boolean;
}

export type Role = "admin" | "operator" | "viewer";

export interface MutationResponse {
  success: boolean;
  message: string;
}

// ── Seal / Unseal Operations ───────────────────────────────────────

export interface SealStatusData {
  sealed: boolean;
  initialized: boolean;
  progress: number;
  threshold: number;
  total_shares: number;
  seal_type: string;   // "shamir" | "pkcs11" | "transit"
  version: string;
  error?: string;
  pkcs11_error?: Pkcs11ErrorInfo | null;
}

export interface UnsealResponse {
  success: boolean;
  sealed: boolean;
  progress: number;
  threshold: number;
  total_shares: number;
  message: string;
  pkcs11_error?: Pkcs11ErrorInfo | null;
}

export interface InitResponse {
  success: boolean;
  message: string;
  unseal_keys?: string[];
  root_token?: string;
  recovery_keys?: string[];
}

// ── HSM / PKCS#11 ─────────────────────────────────────────────────

export interface HsmStatus {
  seal_type: string;
  is_pkcs11: boolean;
  status: "healthy" | "sealed" | "not_configured" | "error" | "connected";
  vault_sealed: boolean;
  vault_initialized: boolean;
  message: string;
  pkcs11_error?: Pkcs11ErrorInfo | null;
}

export interface Pkcs11ErrorInfo {
  code: string;
  label: string;
  suggestion: string;
}
