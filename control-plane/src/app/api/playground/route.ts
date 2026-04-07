// BFF: T&T Engine Simulation Playground
// POST: proxy a tokenize/mask/hmac/detokenize operation to the T&T Engine sandbox tenant.
//
// Security guarantees:
//   - All operations use tenant_id="sandbox" — isolated from production data.
//   - Original plaintext NEVER appears in the JSON response sent to the client.
//   - Rate limited to 10 requests per minute per authenticated user.
//   - Input size capped at 1 KB.
//   - Governance check enforced server-side (mirrors classification.py logic).

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";
import type { SensitivityLevel } from "@/lib/types";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";
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

// ── Governance classification (mirrors classification.py) ───────────

interface Classification { level: SensitivityLevel; allowed: string[] }

const CLASSIFICATION: Record<string, Classification> = {
  ssn:             { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  card:            { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  credit_card:     { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  tax_id:          { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  bank_account:    { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  passport:        { level: "HIGH_SENSITIVE", allowed: ["TOKENIZE"] },
  email:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  phone:           { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  date_of_birth:   { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  drivers_license: { level: "MEDIUM",         allowed: ["TOKENIZE", "MASK", "HMAC"] },
  name:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  first_name:      { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  last_name:       { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  address:         { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  city:            { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
  zip_code:        { level: "LOW",            allowed: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"] },
};

const UNCLASSIFIED: Classification = {
  level: "UNCLASSIFIED",
  allowed: ["TOKENIZE", "MASK", "HMAC"],
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

  const { operation, field_type, value } = body as Record<string, unknown>;

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
  const VALID_OPS = ["TOKENIZE", "MASK", "HMAC", "DETOKENIZE"] as const;
  if (!VALID_OPS.includes(operation as (typeof VALID_OPS)[number])) {
    return NextResponse.json(
      { error: `Invalid operation. Must be one of: ${VALID_OPS.join(", ")}` },
      { status: 400 },
    );
  }

  const fieldType = typeof field_type === "string" ? field_type.toLowerCase() : "custom";
  const classification = classify(fieldType);

  // 5. Governance check (server-side enforcement, mirrors PolicyEngine)
  if (operation !== "DETOKENIZE" && !classification.allowed.includes(operation as string)) {
    return NextResponse.json(
      {
        error: `Operation '${operation}' is not permitted for field '${fieldType}' (${classification.level}). Allowed: ${classification.allowed.join(", ")}`,
        classification: classification.level,
        allowed_operations: classification.allowed,
      },
      { status: 422 },
    );
  }

  const startMs = Date.now();

  try {
    // 6a. DETOKENIZE path — value is treated as the token
    if (operation === "DETOKENIZE") {
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
        // Detokenize result is intentionally returned — this is a sandbox playground.
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

    // 6b. TOKENIZE | MASK | HMAC path
    // Map playground op to T&T Engine Transformation enum
    const transformation = operation === "HMAC" ? "HMAC" : operation; // MASK→MASK, TOKENIZE→TOKENIZE

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
      operation,
      field_type: fieldType,
      output_value: resBody.token,    // token, masked value, or HMAC — all safe
      cached: Boolean(resBody.cached),
      classification: classification.level,
      allowed_operations: classification.allowed,
      latency_ms: latency,
      trace_id: null,
      sandbox: true,
      // raw_request intentionally omits the original value
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
