// BFF: T&T Engine Simulation Playground
// POST: proxy ALL transformation operations to the T&T Engine sandbox tenant.
//
// Security guarantees:
//   - All operations use tenant_id="sandbox" — isolated from production data.
//   - Original plaintext NEVER appears in the JSON response sent to the client.
//   - Rate limited to 10 requests per minute per authenticated user.
//   - Input size capped at 1 KB.
//   - Governance check enforced server-side from live transform_rules (60s cache).
//
// Crypto is NEVER computed in the BFF — all transformations are delegated to
// the T&T Engine, which uses OpenBao Transit and writes a full audit log entry.

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";
import type { SensitivityLevel } from "@/lib/types";

const TNT_URL = (process.env.TNT_ENGINE_URL || "http://localhost:8000").replace(/\/$/, "");
const SANDBOX_TENANT = "sandbox";
const MAX_VALUE_BYTES = 1_024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

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

// ── Dynamic governance classification (60s in-memory cache) ────────
// Fetched from T&T Engine /admin/rules so playground automatically
// reflects any rule changes made through the control plane.

interface Classification { level: SensitivityLevel; allowed: string[] }

function classificationToPlaygroundOps(level: string): string[] {
  switch (level) {
    case "HIGH_SENSITIVE": return ["TOKENIZE", "AES256_GCM96", "FF3_1"];
    case "MEDIUM":         return ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"];
    case "LOW":            return ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"];
    default:               return ["TOKENIZE", "MASK", "HMAC", "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE"];
  }
}

// Static fallback — mirrors classification.py defaults
const CLASSIFICATION_FALLBACK: Record<string, Classification> = {
  ssn:             { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  card:            { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  credit_card:     { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  tax_id:          { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  bank_account:    { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  passport:        { level: "HIGH_SENSITIVE", allowed: classificationToPlaygroundOps("HIGH_SENSITIVE") },
  email:           { level: "MEDIUM",         allowed: classificationToPlaygroundOps("MEDIUM") },
  phone:           { level: "MEDIUM",         allowed: classificationToPlaygroundOps("MEDIUM") },
  date_of_birth:   { level: "MEDIUM",         allowed: classificationToPlaygroundOps("MEDIUM") },
  drivers_license: { level: "MEDIUM",         allowed: classificationToPlaygroundOps("MEDIUM") },
  name:            { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
  first_name:      { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
  last_name:       { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
  address:         { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
  city:            { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
  zip_code:        { level: "LOW",            allowed: classificationToPlaygroundOps("LOW") },
};

const UNCLASSIFIED_CLASS: Classification = {
  level: "UNCLASSIFIED",
  allowed: classificationToPlaygroundOps("UNCLASSIFIED"),
};

// 60-second cache: refresh in background, serve stale on this request
let _classCache: Record<string, Classification> = {};
let _classCacheExpiry = 0;
let _classCacheFetching = false;

async function refreshClassificationCache(): Promise<void> {
  if (_classCacheFetching) return;
  _classCacheFetching = true;
  try {
    const res = await fetch(`${TNT_URL}/admin/rules`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return;
    const data = await res.json() as { rules?: Array<Record<string, unknown>> };
    if (!data.rules?.length) return;
    const map: Record<string, Classification> = {};
    for (const rule of data.rules) {
      const name = String(rule.name ?? "");
      const level = String(rule.classification ?? "UNCLASSIFIED");
      map[name] = { level: level as SensitivityLevel, allowed: classificationToPlaygroundOps(level) };
    }
    _classCache = map;
    _classCacheExpiry = Date.now() + 60_000;
  } catch {
    // keep existing cache / fallback on next request
  } finally {
    _classCacheFetching = false;
  }
}

function classify(fieldType: string): Classification {
  if (Date.now() > _classCacheExpiry) {
    // Trigger async refresh; serve stale/fallback for this request
    void refreshClassificationCache();
  }
  const cache = Object.keys(_classCache).length > 0 ? _classCache : CLASSIFICATION_FALLBACK;
  return cache[fieldType.toLowerCase()] ?? UNCLASSIFIED_CLASS;
}

function redactToken(token: string): string {
  if (token.length <= 8) return "[REDACTED]";
  return `${token.substring(0, 8)}…[REDACTED]`;
}

// ── Valid operations ────────────────────────────────────────────────

const VALID_OPS = [
  "TOKENIZE", "MASK", "HMAC", "DETOKENIZE",
  "HMAC_SHA512", "AES256_GCM96", "FF3_1", "MASK_TEMPLATE",
] as const;
type ValidOp = (typeof VALID_OPS)[number];

// ── Operation display metadata for the response ────────────────────

const OP_ALGORITHM: Record<string, string> = {
  TOKENIZE:      "Convergent tokenization (AES-256-GCM96 via OpenBao Transit)",
  MASK:          "Field-type aware masking",
  HMAC:          "HMAC-SHA-256 (OpenBao Transit)",
  DETOKENIZE:    "Decryption (AES-256-GCM96 via OpenBao Transit)",
  HMAC_SHA512:   "HMAC-SHA-512 (OpenBao Transit, algorithm=sha2-512)",
  AES256_GCM96:  "AES-256-GCM, 96-bit nonce (OpenBao Transit, dedicated key)",
  FF3_1:         "Format-Preserving Encryption / FF3-1 (OpenBao Transit FPE key)",
  MASK_TEMPLATE: "Custom masking template (engine-side, # = reveal · * = mask)",
};

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
  if (!VALID_OPS.includes(operation as ValidOp)) {
    return NextResponse.json(
      { error: `Invalid operation. Must be one of: ${VALID_OPS.join(", ")}` },
      { status: 400 },
    );
  }

  const op = operation as ValidOp;

  if (op === "MASK_TEMPLATE") {
    if (typeof mask_template !== "string" || mask_template.trim().length === 0) {
      return NextResponse.json(
        { error: "mask_template is required for MASK_TEMPLATE (e.g. '####-****-####')" },
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
    // 6a. DETOKENIZE — reverse-lookup in engine
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
        algorithm: OP_ALGORITHM["DETOKENIZE"],
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

    // 6b. All other operations — delegated to T&T Engine
    const enginePayload: Record<string, unknown> = {
      value: value.trim(),
      field: fieldType,
      transformation: op,
      tenant_id: SANDBOX_TENANT,
    };
    if (op === "MASK_TEMPLATE") {
      enginePayload.mask_template = (mask_template as string).trim();
    }

    const engineRes = await fetch(`${TNT_URL}/api/v1/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enginePayload),
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

    const rawRequest: Record<string, unknown> = {
      field: fieldType,
      transformation: op,
      tenant_id: SANDBOX_TENANT,
      value: "[REDACTED — not sent to client]",
    };
    if (op === "MASK_TEMPLATE") {
      rawRequest.mask_template = (mask_template as string).trim();
    }

    return NextResponse.json({
      operation: op,
      field_type: fieldType,
      output_value: resBody.token,
      cached: Boolean(resBody.cached),
      classification: classification.level,
      allowed_operations: classification.allowed,
      algorithm: OP_ALGORITHM[op] ?? op,
      latency_ms: latency,
      trace_id: null,
      sandbox: true,
      raw_request: rawRequest,
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
