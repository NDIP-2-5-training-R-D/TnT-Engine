/**
 * Server-side OpenBao/Vault client wrapper.
 *
 * Centralizes all communication with OpenBao from BFF API routes.
 * This module runs ONLY on the server (Next.js API routes) — never in the browser.
 *
 * Security invariants:
 *   - VAULT_TOKEN is read from process.env and NEVER returned to clients
 *   - All responses are sanitized to remove internal topology info
 *   - PKCS#11 errors are parsed and mapped to human-readable messages
 */

// ── Configuration ──────────────────────────────────────────────────

const VAULT_ADDR = () => process.env.VAULT_ADDR || "http://localhost:8200";
const VAULT_TOKEN = () => process.env.VAULT_TOKEN || "";
const DEFAULT_TIMEOUT = 10_000;

// ── Error Types ────────────────────────────────────────────────────

export class VaultClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly vaultErrors: string[],
    public readonly pkcs11Code: string | null,
    message: string
  ) {
    super(message);
    this.name = "VaultClientError";
  }
}

// ── PKCS#11 Error Mapping ──────────────────────────────────────────

const PKCS11_ERROR_MAP: Record<string, { label: string; suggestion: string }> = {
  CKR_DEVICE_ERROR:         { label: "HSM Device Error",           suggestion: "Check HSM hardware connection and power. Restart the HSM if needed." },
  CKR_DEVICE_REMOVED:       { label: "HSM Device Removed",        suggestion: "The HSM device was disconnected. Reconnect and restart OpenBao." },
  CKR_TOKEN_NOT_PRESENT:    { label: "HSM Token Not Present",     suggestion: "The PKCS#11 token slot is empty. Initialize the slot with softhsm2-util." },
  CKR_TOKEN_NOT_RECOGNIZED: { label: "HSM Token Unrecognized",    suggestion: "Token data may be corrupted. Re-initialize with softhsm2-util --init-token." },
  CKR_PIN_INCORRECT:        { label: "HSM PIN Incorrect",         suggestion: "The PKCS#11 PIN is wrong. Check the SOFTHSM_PIN environment variable." },
  CKR_PIN_LOCKED:           { label: "HSM PIN Locked",            suggestion: "Too many failed PIN attempts. Reset the token with SO-PIN." },
  CKR_KEY_HANDLE_INVALID:   { label: "HSM Key Handle Invalid",    suggestion: "The seal key was not found. Verify the key label in OpenBao config." },
  CKR_MECHANISM_INVALID:    { label: "HSM Mechanism Invalid",     suggestion: "Unsupported crypto mechanism. Check the 'mechanism' field in seal config." },
  CKR_SESSION_HANDLE_INVALID: { label: "HSM Session Invalid",     suggestion: "PKCS#11 session expired. Restart OpenBao to create new sessions." },
  CKR_GENERAL_ERROR:        { label: "HSM General Error",         suggestion: "Generic HSM failure. Check OpenBao server logs for details." },
};

export function parsePkcs11Error(errorMessages: string[]): {
  code: string;
  label: string;
  suggestion: string;
} | null {
  const joined = errorMessages.join(" ");
  for (const [code, info] of Object.entries(PKCS11_ERROR_MAP)) {
    if (joined.includes(code)) {
      return { code, ...info };
    }
  }
  // Check for generic PKCS#11 pattern
  const match = joined.match(/CKR_[A-Z_]+/);
  if (match) {
    return {
      code: match[0],
      label: `PKCS#11 Error: ${match[0]}`,
      suggestion: "Unknown PKCS#11 error. Check OpenBao server logs.",
    };
  }
  return null;
}

// ── Core Request Function ──────────────────────────────────────────

interface VaultRequestOptions {
  method?: string;
  body?: unknown;
  timeout?: number;
  authenticated?: boolean; // default true
  namespace?: string;      // OpenBao namespace (X-Vault-Namespace header)
}

export async function vaultRequest<T = unknown>(
  path: string,
  options: VaultRequestOptions = {}
): Promise<T> {
  const { method = "GET", body, timeout = DEFAULT_TIMEOUT, authenticated = true, namespace } = options;

  const headers: Record<string, string> = {};
  if (authenticated) {
    headers["X-Vault-Token"] = VAULT_TOKEN();
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  if (namespace) {
    headers["X-Vault-Namespace"] = namespace;
  }

  const url = `${VAULT_ADDR()}/v1${path}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });

  // 204 No Content — success with no body
  if (res.status === 204) {
    return { success: true } as T;
  }

  let responseBody: any;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = {};
  }

  if (!res.ok) {
    const errors: string[] = responseBody?.errors ?? [res.statusText];
    const pkcs11 = parsePkcs11Error(errors);

    throw new VaultClientError(
      res.status,
      errors,
      pkcs11?.code ?? null,
      pkcs11 ? `${pkcs11.label}: ${pkcs11.suggestion}` : `Vault error ${res.status}: ${errors.join(", ")}`
    );
  }

  return responseBody;
}

// ── Convenience Methods ────────────────────────────────────────────

export async function vaultGet<T = any>(path: string): Promise<T> {
  return vaultRequest<T>(path, { method: "GET" });
}

export async function vaultPost<T = any>(path: string, body?: unknown): Promise<T> {
  return vaultRequest<T>(path, { method: "POST", body });
}

export async function vaultPut<T = any>(path: string, body?: unknown): Promise<T> {
  return vaultRequest<T>(path, { method: "PUT", body });
}

// ── Health (unauthenticated) ───────────────────────────────────────

export interface SealStatus {
  sealed: boolean;
  initialized: boolean;
  t: number;       // threshold (key shares needed to unseal)
  n: number;       // total key shares
  progress: number; // current unseal progress
  version: string;
  nonce: string;   // unseal nonce (changes each seal cycle)
  type: string;    // seal type: "shamir" | "pkcs11" | "transit"
}

export async function getSealStatus(): Promise<SealStatus> {
  const res = await fetch(`${VAULT_ADDR()}/v1/sys/seal-status`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  return {
    sealed: body.sealed ?? true,
    initialized: body.initialized ?? false,
    t: body.t ?? 0,
    n: body.n ?? 0,
    progress: body.progress ?? 0,
    version: body.version ?? "",
    nonce: body.nonce ?? "",
    type: body.type ?? "unknown",
  };
}

// ── Unseal ─────────────────────────────────────────────────────────

export interface UnsealResult {
  sealed: boolean;
  progress: number;
  t: number;
  n: number;
}

export async function submitUnsealKey(key: string): Promise<UnsealResult> {
  const res = await fetch(`${VAULT_ADDR()}/v1/sys/unseal`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  return {
    sealed: body.sealed ?? true,
    progress: body.progress ?? 0,
    t: body.t ?? 0,
    n: body.n ?? 0,
  };
}

// ── Init ───────────────────────────────────────────────────────────

export interface InitResult {
  keys: string[];           // Unseal keys (BASE64)
  keys_base64: string[];    // Unseal keys (BASE64)
  root_token: string;       // Root token
  recovery_keys?: string[];
  recovery_keys_base64?: string[];
}

export async function initVault(
  secretShares: number,
  secretThreshold: number
): Promise<InitResult> {
  const res = await fetch(`${VAULT_ADDR()}/v1/sys/init`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret_shares: secretShares,
      secret_threshold: secretThreshold,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new VaultClientError(res.status, body?.errors ?? ["Init failed"], null, "Vault initialization failed");
  }
  return res.json();
}
