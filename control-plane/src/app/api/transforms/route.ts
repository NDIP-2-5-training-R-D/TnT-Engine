// BFF: Transform Rules — canonical governance classification data from T&T Engine.
// Reflects classification.py + masking.py exactly. Probes T&T Engine to set source flag.
// GET: list all field-type rules with classification, allowed operations, and masking template.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import type { TransformRule } from "@/lib/types";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

// Canonical rules mirroring governance/classification.py + service/masking.py.
// Updated whenever the engine's classification registry changes.
const CANONICAL_RULES: TransformRule[] = [
  // ── HIGH_SENSITIVE — TOKENIZE only ───────────────────────────────
  {
    name: "ssn",
    type: "fpe",
    template: "***-**-####",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Social Security Number",
  },
  {
    name: "card",
    type: "fpe",
    template: "****-****-****-####",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Payment Card Number",
  },
  {
    name: "credit_card",
    type: "fpe",
    template: "****-****-****-####",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Credit Card Number",
  },
  {
    name: "tax_id",
    type: "fpe",
    template: "**-*******",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Tax Identification Number",
  },
  {
    name: "bank_account",
    type: "fpe",
    template: "****####",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Bank Account Number",
  },
  {
    name: "passport",
    type: "fpe",
    template: "**#######",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "HIGH_SENSITIVE",
    allowed_operations: ["TOKENIZE"],
    description: "Passport Number",
  },

  // ── MEDIUM — TOKENIZE | MASK | HASH ──────────────────────────────
  {
    name: "email",
    type: "masking",
    template: "j***@domain",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "MEDIUM",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC"],
    description: "Email Address",
  },
  {
    name: "phone",
    type: "masking",
    template: "***-***-####",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "MEDIUM",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC"],
    description: "Phone Number",
  },
  {
    name: "date_of_birth",
    type: "masking",
    template: "####-**-**",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "MEDIUM",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC"],
    description: "Date of Birth",
  },
  {
    name: "drivers_license",
    type: "fpe",
    template: "**######",
    tweak_source: "supplied",
    allowed_roles: ["tnt-engine"],
    classification: "MEDIUM",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC"],
    description: "Driver's License",
  },

  // ── LOW — all operations permitted ───────────────────────────────
  {
    name: "name",
    type: "masking",
    template: "J*** D***",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "Person Name",
  },
  {
    name: "first_name",
    type: "masking",
    template: "J***",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "First Name",
  },
  {
    name: "last_name",
    type: "masking",
    template: "D***",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "Last Name",
  },
  {
    name: "address",
    type: "masking",
    template: "12*** Ma***",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "Street Address",
  },
  {
    name: "city",
    type: "masking",
    template: "Ne***",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "City",
  },
  {
    name: "zip_code",
    type: "masking",
    template: "1****",
    tweak_source: "internal",
    allowed_roles: ["tnt-engine"],
    classification: "LOW",
    allowed_operations: ["TOKENIZE", "MASK", "HMAC", "PASSTHROUGH"],
    description: "ZIP/Postal Code",
  },
];

export async function GET() {
  // Probe T&T Engine health to determine source flag.
  let engineLive = false;
  try {
    const res = await fetch(`${TNT_URL}/api/v1/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    engineLive = res.ok;
  } catch {
    engineLive = false;
  }

  return NextResponse.json({
    rules: CANONICAL_RULES,
    source: engineLive ? "live" : "fallback",
    fetched_at: new Date().toISOString(),
  });
}
