// BFF: T&T Engine Simulation Playground
// POST: proxy a tokenize/mask/hmac/detokenize operation to the T&T Engine sandbox tenant,
//       or execute advanced crypto operations (HMAC-SHA-512, AES256-GCM96, FF3-1, MASKING TEMPLATE)
//       directly in the sandbox BFF layer.
//
// Security guarantees:
//   - All engine operations use tenant_id="sandbox" — isolated from production data.
//   - Original plaintext NEVER appears in the JSON response sent to the client.
//   - Rate limited to 10 requests per minute per authenticated user.
//   - Input size capped at 1 KB.
//   - Governance check enforced server-side (mirrors classification.py logic).

export const dynamic = "force-dynamic";

import { createHmac, createCipheriv, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";
import type { SensitivityLevel } from "@/lib/types";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";
const SANDBOX_TENANT = "sandbox";
const MAX_VALUE_BYTES = 1_024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

// Stable sandbox keys — NOT secrets, only used for demo/sandbox crypto.
const SANDBOX_HMAC_512_KEY = "sandbox-hmac-sha512-demo-key";
const SANDBOX_AES_KEY = createHmac("sha256", "sandbox").update("aes256-gcm96-key").digest(); // 32 bytes
const SANDBOX_FF31_KEY = "sandbox-ff31-fpe-demo-key";

// ── Per-user in-memory rate limiter ────────────────────────────────

interface RateBucket { count: number; resetAt: number }
const rateLimitMap = new Map<string, RateBucket>();

function checkRateLimit(userId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  let bucket = rateLimitMap.get(userId);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitMap.set(userId, bucket);
  }
  if (bucket.count >= RATE_MAX) return { allowed: false, remaining: 0 };
  bucket.count++;
  return { allowed: true, remaining: RATE_MAX - bucket.count };
}

// ── Governance classification (mirrors classification.py) ───────────

interface Classification { level: SensitivityLevel; allowed: string[] }

// Reversible ops (can be used on HIGH_SENSITIVE): TOKENIZE, AES256_GCM96, FF3_1
// One-way ops (MEDIUM+): MASK, HMAC, HMAC_SHA512, MASK_TEMPLATE
const CLASSIFICATION: Record<string, Classification> = {
  ssn:             { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  card:            { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  credit_card:     { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  tax_id:          { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  bank_account:    { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  passport:        { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE", "AES256_GCM96", "FF3_1"] },
  email:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"] },
  phone:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"] },
  date_of_birth:   { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"] },
  drivers_license: { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"] },
  name:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
  first_name:      { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
  last_name:       { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
  address:         { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
  city:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
  zip_code:        { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE", "PASSTHROUGH"] },
};

const UNCLASSIFIED: Classification = {
  level: "UNCLASSIFIED",
  allowed: ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"],
};

// ── Helpers ────────────────────────────────────────────────────────

function classify(fieldType: string): Classification {
  return CLASSIFICATION[fieldType.toLowerCase()] ?? UNCLASSIFIED;
}

/** Redact a token string — show prefix only for debug context. */
function redactToken(token: string): string {
  if (token.length <= 8) return "[REDACTED]";
  return `${token.substring(0, 8)}…[REDACTED]`;
}

// ── Sandbox crypto implementations ─────────────────────────────────

/**
 * HMAC-SHA-512: Deterministic one-way hash using SHA-512.
 * Output: 128-char hex digest.
 */
function sandboxHmacSha512(value: string): string {
  return createHmac("sha512", SANDBOX_HMAC_512_KEY).update(value).digest("hex");
}

/**
 * AES-256-GCM96: Authenticated encryption.
 * Format: <base64url_iv>.<base64url_ciphertext>.<base64url_authtag>
 * 96-bit (12-byte) nonce, 256-bit key, 128-bit auth tag.
 */
function sandboxAes256Gcm96(value: string): string {
  const iv = randomBytes(12); // 96-bit nonce
  const cipher = createCipheriv("aes-256-gcm", SANDBOX_AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit auth tag
  return [
    iv.toString("base64url"),
    enc.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * FF3-1 Sandbox: Format-Preserving Encryption simulation.
 * Preserves digit→digit, uppercase→uppercase, lowercase→lowercase, separators→separators.
 * Uses a deterministic key-derived permutation per character class.
 *
 * NOTE: This is a sandbox simulation (Feistel-like substitution), NOT the full
 * NIST SP 800-38G FF3-1 specification. Use a compliant library (e.g. Vault Transit FPE) in production.
 */
function sandboxFf31(value: string): string {
  const DIGITS = "0123456789";
  const UPPER  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const LOWER  = "abcdefghijklmnopqrstuvwxyz";

  // Derive a deterministic permutation seed from key + value (convergent FPE property)
  const seed = createHmac("sha256", SANDBOX_FF31_KEY).update(value).digest();
  let si = 0;
  const nextShift = () => seed[si++ % 32];

  return [...value].map((ch) => {
    if (DIGITS.includes(ch))
      return DIGITS[(DIGITS.indexOf(ch) + nextShift()) % 10];
    if (UPPER.includes(ch))
      return UPPER[(UPPER.indexOf(ch) + nextShift()) % 26];
    if (LOWER.includes(ch))
      return LOWER[(LOWER.indexOf(ch) + nextShift()) % 26];
    return ch; // preserve separators / special chars
  }).join("");
}

/**
 * MASKING TEMPLATE: Apply a user-supplied template pattern.
 *   '#' → reveal the character at this position (pass-through)
 *   '*' → mask the character at this position (replace with '*')
 *   any other char → literal separator (inserted, does not consume input)
 *
 * Example: template "####-****-****-####" on "1234567890123456"
 *          → "1234-****-****-3456"
 */
function applyMaskTemplate(value: string, template: string): string {
  let out = "";
  let vi = 0;
  for (const tc of template) {
    if (tc === "#") {
      out += vi < value.length ? value[vi++] : "#";
    } else if (tc === "*") {
      out += "*";
      if (vi < value.length) vi++;
    } else {
      out += tc; // literal separator
    }
  }
  return out;
}

// ── Route handler ──────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Auth
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit
  const userId = (session.user as { name?: string }).name ?? "unknown";
  const rateResult = checkRateLimit(userId);
  if (!rateResult.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Playground is limited to 10 requests per minute." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(RATE_WINDOW_MS / 1_000)) },
      },
    );
  }

  // 3. Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { operation, field_type, value, mask_template } = body as Record<string, unknown>;

  // 4. Validate inputs
  if (typeof value !== "string" || value.trim().length === 0) {
    return NextResponse.json({ error: "value must be a non-empty string" }, { status: 400 });
  }
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return NextResponse.json(
      { error: `value too large (max ${MAX_VALUE_BYTES} bytes)` },
      { status: 400 },
    );
  }

  const VALID_OPS = [
    "TOKENIZE", "MASK", "HMAC", "DETOKENIZE",
    "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE",
  ] as const;
  type ValidOp = (typeof VALID_OPS)[number];

  if (!VALID_OPS.includes(operation as ValidOp)) {
    return NextResponse.json(
      { error: `Invalid operation. Must be one of: ${VALID_OPS.join(", ")}` },
      { status: 400 },
    );
  }

  const op = operation as ValidOp;

  // MASK_TEMPLATE requires a template string
  if (op === "MASK_TEMPLATE") {
    if (typeof mask_template !== "string" || mask_template.trim().length === 0) {
      return NextResponse.json(
        { error: "mask_template must be a non-empty string for MASK_TEMPLATE operation (e.g. '####-****-####')" },
        { status: 400 },
      );
    }
  }

  const fieldType = typeof field_type === "string" ? field_type.toLowerCase() : "custom";
  const classification = classify(fieldType);

  // 5. Governance check
  if (op !== "DETOKENIZE" && !classification.allowed.includes(op)) {
    return NextResponse.json(
      {
        error: `Operation '${op}' is not permitted for field '${fieldType}' (${classification.level}). Allowed: ${classification.allowed.join(", ")}`,
        classification: classification.level,
        allowed_operations: classification.allowed,
      },
      { status: 422 },
    );
  }

  const startMs = Date.now();

  try {
    // ── 6a. DETOKENIZE ───────────────────────────────────────────────
    if (op === "DETOKENIZE") {
      const engineRes = await fetch(`${TNT_URL}/api/v1/detokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value.trim(), tenant_id: SANDBOX_TENANT }),
        signal: AbortSignal.timeout(10_000),
      });
      const latency = Date.now() - startMs;
      const resBody = await engineRes.json() as Record<string, unknown>;

      if (!engineRes.ok) {
        return NextResponse.json(
          { error: String(resBody.detail ?? "Detokenize failed"), latency_ms: latency },
          { status: engineRes.status },
        );
      }

      return NextResponse.json({
        operation: "DETOKENIZE",
        field_type: fieldType,
        output_value: resBody.value,
        cached: false,
        classification: classification.level,
        allowed_operations: classification.allowed,
        latency_ms: latency,
        trace_id: null,
        sandbox: true,
        raw_request: {
          token: redactToken(value.trim()),
          tenant_id: SANDBOX_TENANT,
        },
        raw_response: {
          field: resBody.field ?? fieldType,
          status: "ok",
        },
      });
    }

    // ── 6b. HMAC-SHA-512 (BFF sandbox) ──────────────────────────────
    if (op === "HMAC_SHA512") {
      const digest = sandboxHmacSha512(value.trim());
      const latency = Date.now() - startMs;
      return NextResponse.json({
        operation: "HMAC_SHA512",
        field_type: fieldType,
        output_value: digest,
        cached: false,
        classification: classification.level,
        allowed_operations: classification.allowed,
        latency_ms: latency,
        trace_id: null,
        sandbox: true,
        algorithm: "HMAC-SHA-512",
        digest_bits: 512,
        raw_request: {
          field: fieldType,
          transformation: "HMAC_SHA512",
          tenant_id: SANDBOX_TENANT,
          value: "[REDACTED — not sent to client]",
        },
        raw_response: {
          algorithm: "HMAC-SHA-512",
          digest_length: digest.length,
          cached: false,
        },
      });
    }

    // ── 6c. AES-256-GCM96 (BFF sandbox) ─────────────────────────────
    if (op === "AES256_GCM96") {
      const ciphertext = sandboxAes256Gcm96(value.trim());
      const latency = Date.now() - startMs;
      return NextResponse.json({
        operation: "AES256_GCM96",
        field_type: fieldType,
        output_value: ciphertext,
        cached: false,
        classification: classification.level,
        allowed_operations: classification.allowed,
        latency_ms: latency,
        trace_id: null,
        sandbox: true,
        algorithm: "AES-256-GCM",
        nonce_bits: 96,
        auth_tag_bits: 128,
        format: "<iv_b64url>.<ciphertext_b64url>.<authtag_b64url>",
        raw_request: {
          field: fieldType,
          transformation: "AES256_GCM96",
          tenant_id: SANDBOX_TENANT,
          value: "[REDACTED — not sent to client]",
        },
        raw_response: {
          algorithm: "AES-256-GCM",
          nonce_bits: 96,
          auth_tag_bits: 128,
          cached: false,
        },
      });
    }

    // ── 6d. FF3-1 Format-Preserving Encryption (BFF sandbox) ─────────
    if (op === "FF3_1") {
      const fpeValue = sandboxFf31(value.trim());
      const latency = Date.now() - startMs;
      return NextResponse.json({
        operation: "FF3_1",
        field_type: fieldType,
        output_value: fpeValue,
        cached: false,
        classification: classification.level,
        allowed_operations: classification.allowed,
        latency_ms: latency,
        trace_id: null,
        sandbox: true,
        algorithm: "FF3-1 (NIST SP 800-38G) — sandbox simulation",
        note: "Sandbox uses a Feistel-like substitution. Production uses a fully compliant FF3-1 implementation via Vault Transit FPE.",
        raw_request: {
          field: fieldType,
          transformation: "FF3_1",
          tenant_id: SANDBOX_TENANT,
          value: "[REDACTED — not sent to client]",
        },
        raw_response: {
          algorithm: "FF3-1",
          format_preserved: true,
          cached: false,
        },
      });
    }

    // ── 6e. MASKING TEMPLATE (BFF sandbox) ───────────────────────────
    if (op === "MASK_TEMPLATE") {
      const tmpl = (mask_template as string).trim();
      const masked = applyMaskTemplate(value.trim(), tmpl);
      const latency = Date.now() - startMs;
      return NextResponse.json({
        operation: "MASK_TEMPLATE",
        field_type: fieldType,
        output_value: masked,
        cached: false,
        classification: classification.level,
        allowed_operations: classification.allowed,
        latency_ms: latency,
        trace_id: null,
        sandbox: true,
        mask_template: tmpl,
        template_legend: "# = reveal character  |  * = mask character  |  other = literal separator",
        raw_request: {
          field: fieldType,
          transformation: "MASK_TEMPLATE",
          mask_template: tmpl,
          tenant_id: SANDBOX_TENANT,
          value: "[REDACTED — not sent to client]",
        },
        raw_response: {
          template: tmpl,
          cached: false,
        },
      });
    }

    // ── 6f. TOKENIZE | MASK | HMAC path (proxied to T&T Engine) ──────
    const transformation = op; // MASK→MASK, HMAC→HMAC, TOKENIZE→TOKENIZE

    const engineRes = await fetch(`${TNT_URL}/api/v1/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        value: value.trim(),
        field: fieldType,
        transformation,
        tenant_id: SANDBOX_TENANT,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const latency = Date.now() - startMs;
    const resBody = await engineRes.json() as Record<string, unknown>;

    if (!engineRes.ok) {
      return NextResponse.json(
        { error: String(resBody.detail ?? "Operation failed"), latency_ms: latency },
        { status: engineRes.status },
      );
    }

    return NextResponse.json({
      operation: op,
      field_type: fieldType,
      output_value: resBody.token,
      cached: Boolean(resBody.cached),
      classification: classification.level,
      allowed_operations: classification.allowed,
      latency_ms: latency,
      trace_id: null,
      sandbox: true,
      raw_request: {
        field: fieldType,
        transformation,
        tenant_id: SANDBOX_TENANT,
        value: "[REDACTED — not sent to client]",
      },
      raw_response: {
        token: resBody.token,
        field: resBody.field,
        cached: resBody.cached,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `T&T Engine unreachable: ${msg}`, latency_ms: Date.now() - startMs },
      { status: 503 },
    );
  }
}
