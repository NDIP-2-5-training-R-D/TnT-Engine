// BFF: Transform Rules — fetched live from T&T Engine admin API.
// Falls back to seeded CANONICAL_RULES when the engine is unreachable.
// GET  — list all active rules (all authenticated roles)
// POST — create a new rule (admin / manager only)

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireRole } from "@/lib/rbac";
import type { TransformRule } from "@/lib/types";

const TNT_URL = (process.env.TNT_ENGINE_URL || "http://localhost:8000").replace(/\/$/, "");

// Fallback canonical rules — used only when engine is unreachable.
const CANONICAL_RULES: TransformRule[] = [
  { name: "ssn",             type: "fpe",     template: "***-**-####",          tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Social Security Number" },
  { name: "card",            type: "fpe",     template: "****-****-****-####",   tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Payment Card Number" },
  { name: "credit_card",     type: "fpe",     template: "****-****-****-####",   tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Credit Card Number" },
  { name: "tax_id",          type: "fpe",     template: "**-*******",            tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Tax Identification Number" },
  { name: "bank_account",    type: "fpe",     template: "****####",              tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Bank Account Number" },
  { name: "passport",        type: "fpe",     template: "**#######",             tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "HIGH_SENSITIVE", allowed_operations: ["TOKENIZE"],                            description: "Passport Number" },
  { name: "email",           type: "masking", template: "j***@domain",           tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "MEDIUM",         allowed_operations: ["TOKENIZE", "MASK", "HMAC"],            description: "Email Address" },
  { name: "phone",           type: "masking", template: "***-***-####",          tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "MEDIUM",         allowed_operations: ["TOKENIZE", "MASK", "HMAC"],            description: "Phone Number" },
  { name: "date_of_birth",   type: "masking", template: "####-**-**",            tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "MEDIUM",         allowed_operations: ["TOKENIZE", "MASK", "HMAC"],            description: "Date of Birth" },
  { name: "drivers_license", type: "fpe",     template: "**######",              tweak_source: "supplied",  allowed_roles: ["tnt-engine"], classification: "MEDIUM",         allowed_operations: ["TOKENIZE", "MASK", "HMAC"],            description: "Driver's License" },
  { name: "name",            type: "masking", template: "J*** D***",             tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "Person Name" },
  { name: "first_name",      type: "masking", template: "J***",                  tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "First Name" },
  { name: "last_name",       type: "masking", template: "D***",                  tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "Last Name" },
  { name: "address",         type: "masking", template: "12*** Ma***",           tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "Street Address" },
  { name: "city",            type: "masking", template: "Ne***",                 tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "City" },
  { name: "zip_code",        type: "masking", template: "1****",                 tweak_source: "internal",  allowed_roles: ["tnt-engine"], classification: "LOW",            allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"], description: "ZIP/Postal Code" },
];

// ── GET /api/transforms ───────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;
  // 1. Confirm engine is reachable via health endpoint
  let engineAlive = false;
  try {
    const h = await fetch(`${TNT_URL}/api/v1/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    engineAlive = h.ok;
  } catch {
    engineAlive = false;
  }

  // 2. If alive, fetch rules from admin API
  if (engineAlive) {
    try {
      const res = await fetch(`${TNT_URL}/admin/rules`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json();
        const rules: TransformRule[] = (data.rules ?? []).map((r: Record<string, unknown>) => ({
          name: r.name,
          type: r.type ?? "masking",
          template: r.template ?? "",
          tweak_source: r.tweak_source ?? "internal",
          allowed_roles: r.allowed_roles ?? ["tnt-engine"],
          classification: r.classification,
          allowed_operations: r.allowed_operations ?? [],
          description: r.description ?? "",
          retention_days: r.retention_days ?? null,
        }));
        return NextResponse.json({
          rules,
          source: "live" as const,
          fetched_at: new Date().toISOString(),
          engine_url: TNT_URL,
        });
      }
      // Engine is alive but /admin/rules failed (table missing? not restarted?)
      const errText = await res.text().catch(() => res.status.toString());
      console.warn(`[transforms] /admin/rules returned ${res.status}: ${errText}`);
    } catch (err) {
      console.warn(`[transforms] /admin/rules fetch error:`, err);
    }
  }

  // 3. Fallback to built-in canonical rules
  return NextResponse.json({
    rules: CANONICAL_RULES,
    source: "fallback" as const,
    fetched_at: new Date().toISOString(),
    engine_url: TNT_URL,
  });
}

// ── POST /api/transforms — create a new rule (admin / manager only) ──

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ["admin", "manager"]);
  if (auth.error) return auth.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${TNT_URL}/admin/rules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Engine unreachable", detail: String(err) },
      { status: 503 }
    );
  }
}
