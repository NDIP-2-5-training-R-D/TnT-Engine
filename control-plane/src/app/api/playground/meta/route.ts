// BFF: Playground metadata endpoint.
// GET /api/playground/meta
//
// Returns the operation catalogue and default mask templates derived from
// the canonical transform rules stored in the T&T Engine.  The frontend uses
// this so that ADVANCED_OPS and DEFAULT_MASK_TEMPLATES are never hardcoded —
// they come from the same source-of-truth as the governance classification.
//
// No auth required (metadata is not sensitive); rate-limiting is on the
// /api/playground POST endpoint.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { PlaygroundOp } from "@/lib/types";
import type { PlaygroundOperation } from "@/lib/types";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

// ── Operation catalogue ────────────────────────────────────────────
// Single source of truth for display metadata of all playground operations.
// Sourced at runtime; UI derives STANDARD_OPS / ADVANCED_OPS from this list.

export interface OpMeta {
  id: PlaygroundOperation;
  label: string;
  description: string;
  group: "standard" | "advanced";
  badge?: string;
  reversible: boolean;
}

const OP_CATALOGUE: OpMeta[] = [
  {
    id: PlaygroundOp.TOKENIZE,
    label: "TOKENIZE",
    description: "Reversible — opaque tok_… token",
    group: "standard",
    reversible: true,
  },
  {
    id: PlaygroundOp.MASK,
    label: "MASK",
    description: "One-way — preserves structure, hides value",
    group: "standard",
    reversible: false,
  },
  {
    id: PlaygroundOp.HMAC,
    label: "HMAC",
    description: "SHA-256 one-way hash (OpenBao Transit)",
    group: "standard",
    reversible: false,
  },
  {
    id: PlaygroundOp.DETOKENIZE,
    label: "DETOKENIZE",
    description: "Recover original value from a tok_… token",
    group: "standard",
    reversible: true,
  },
  {
    id: PlaygroundOp.HMAC_SHA512,
    label: "HMAC-SHA-512",
    description: "512-bit one-way HMAC digest (OpenBao Transit, sha2-512)",
    group: "advanced",
    badge: "SHA-512",
    reversible: false,
  },
  {
    id: PlaygroundOp.AES256_GCM96,
    label: "AES256-GCM96",
    description: "Authenticated encryption, 96-bit nonce (OpenBao Transit, tnt-aes-gcm key)",
    group: "advanced",
    badge: "AES",
    reversible: true,
  },
  {
    id: PlaygroundOp.FF3_1,
    label: "FF3-1",
    description: "Format-Preserving Encryption — NIST SP 800-38G (DEK via envelope encryption)",
    group: "advanced",
    badge: "FPE",
    reversible: true,
  },
  {
    id: PlaygroundOp.MASK_TEMPLATE,
    label: "MASKING TEMPLATE",
    description: "Custom template: # = reveal · * = mask · other = separator",
    group: "advanced",
    badge: "TPL",
    reversible: false,
  },
];

// ── Default mask templates ─────────────────────────────────────────
// Derived from the T&T Engine transform rules.  Falls back to hardcoded
// CANONICAL snapshot when the engine is unreachable.

const CANONICAL_TEMPLATES: Record<string, string> = {
  ssn:             "***-**-####",
  card:            "****-****-****-####",
  credit_card:     "****-****-****-####",
  tax_id:          "**-*******",
  bank_account:    "****####",
  passport:        "**#######",
  email:           "###@****",
  phone:           "***-***-####",
  date_of_birth:   "####-**-**",
  drivers_license: "**######",
  name:            "# D***",
  first_name:      "J***",
  last_name:       "D***",
  address:         "### ****",
  city:            "Ne***",
  zip_code:        "1****",
  custom:          "##****##",
};

async function fetchTemplatesFromEngine(): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${TNT_URL}/api/v1/transforms/rules`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return CANONICAL_TEMPLATES;
    const data = await res.json() as { rules?: Array<{ name: string; template: string }> };
    if (!data.rules) return CANONICAL_TEMPLATES;
    const out: Record<string, string> = { ...CANONICAL_TEMPLATES };
    for (const rule of data.rules) {
      if (rule.name && rule.template) out[rule.name] = rule.template;
    }
    return out;
  } catch {
    return CANONICAL_TEMPLATES;
  }
}

// ── Handler ────────────────────────────────────────────────────────

export async function GET() {
  const maskTemplates = await fetchTemplatesFromEngine();

  return NextResponse.json(
    {
      operations: OP_CATALOGUE,
      mask_templates: maskTemplates,
      fetched_at: new Date().toISOString(),
    },
    {
      headers: {
        // Cache 60 s in browser; CDN can also cache since this is non-sensitive metadata.
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    },
  );
}
