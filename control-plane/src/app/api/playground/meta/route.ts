// BFF: Playground metadata endpoint.
// GET /api/playground/meta
//
// Returns operation catalogue, mask templates, AND field definitions
// derived live from the transform_rules table via T&T Engine /admin/rules.
// The frontend uses this so FIELD_DEFS, allowed operations, and mask templates
// are never hardcoded — they always reflect the admin-managed rules.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { PlaygroundOp } from "@/lib/types";
import type { PlaygroundOperation, SensitivityLevel } from "@/lib/types";

const TNT_URL = (process.env.TNT_ENGINE_URL || "http://localhost:8000").replace(/\/$/, "");

// ── Operation catalogue ────────────────────────────────────────────

export interface OpMeta {
  id: PlaygroundOperation;
  label: string;
  description: string;
  group: "standard" | "advanced";
  badge?: string;
  reversible: boolean;
}

const OP_CATALOGUE: OpMeta[] = [
  { id: PlaygroundOp.TOKENIZE,      label: "TOKENIZE",         description: "Reversible — opaque tok_… token",                                             group: "standard", reversible: true  },
  { id: PlaygroundOp.MASK,          label: "MASK",             description: "One-way — preserves structure, hides value",                                  group: "standard", reversible: false },
  { id: PlaygroundOp.HMAC,          label: "HMAC",             description: "SHA-256 one-way hash (OpenBao Transit)",                                      group: "standard", reversible: false },
  { id: PlaygroundOp.DETOKENIZE,    label: "DETOKENIZE",       description: "Recover original value from a tok_… token",                                   group: "standard", reversible: true  },
  { id: PlaygroundOp.HMAC_SHA512,   label: "HMAC-SHA-512",     description: "512-bit one-way HMAC digest (OpenBao Transit, sha2-512)",                     group: "advanced", badge: "SHA-512", reversible: false },
  { id: PlaygroundOp.AES256_GCM96,  label: "AES256-GCM96",     description: "Authenticated encryption, 96-bit nonce (OpenBao Transit, tnt-aes-gcm key)",   group: "advanced", badge: "AES",     reversible: true  },
  { id: PlaygroundOp.FF3_1,         label: "FF3-1",            description: "Format-Preserving Encryption — NIST SP 800-38G (DEK via envelope encryption)", group: "advanced", badge: "FPE",     reversible: true  },
  { id: PlaygroundOp.MASK_TEMPLATE, label: "MASKING TEMPLATE", description: "Custom template: # = reveal · * = mask · other = separator",                  group: "advanced", badge: "TPL",     reversible: false },
];

// ── Field definition shape returned to the UI ──────────────────────

export interface FieldDefMeta {
  name: string;
  label: string;
  classification: SensitivityLevel;
  /** Playground operations allowed for this field (derived from classification level) */
  allowed_operations: PlaygroundOperation[];
  template: string;
  placeholder: string;
  example: string;
}

// ── Known examples for well-known field types ──────────────────────
// Used to provide realistic placeholders and example values in the UI.
// Unknown field types fall back to a generic placeholder.

const KNOWN_EXAMPLES: Record<string, { placeholder: string; example: string }> = {
  ssn:             { placeholder: "e.g. 123-45-6789",         example: "123-45-6789"         },
  card:            { placeholder: "e.g. 4111111111111111",     example: "4111111111111111"     },
  credit_card:     { placeholder: "e.g. 4111111111111111",     example: "4111111111111111"     },
  tax_id:          { placeholder: "e.g. 12-3456789",           example: "12-3456789"           },
  bank_account:    { placeholder: "e.g. 123456789012",         example: "123456789012"         },
  passport:        { placeholder: "e.g. A12345678",            example: "A12345678"            },
  email:           { placeholder: "e.g. user@example.com",     example: "user@example.com"     },
  phone:           { placeholder: "e.g. 555-867-5309",         example: "555-867-5309"         },
  date_of_birth:   { placeholder: "e.g. 1990-07-15",           example: "1990-07-15"           },
  drivers_license: { placeholder: "e.g. D12345678",            example: "D12345678"            },
  name:            { placeholder: "e.g. John Doe",             example: "John Doe"             },
  first_name:      { placeholder: "e.g. John",                 example: "John"                 },
  last_name:       { placeholder: "e.g. Doe",                  example: "Doe"                  },
  address:         { placeholder: "e.g. 123 Main St",          example: "123 Main St"          },
  city:            { placeholder: "e.g. New York",             example: "New York"             },
  zip_code:        { placeholder: "e.g. 10001",                example: "10001"                },
};

// ── Classification → playground operations mapping ─────────────────
// Playground expands the basic allowed_operations from the DB rule into
// the full set of crypto operations meaningful in the UI.

function classificationToPlaygroundOps(level: string): PlaygroundOperation[] {
  switch (level) {
    case "HIGH_SENSITIVE":
      return [PlaygroundOp.TOKENIZE, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1];
    case "MEDIUM":
      return [PlaygroundOp.TOKENIZE, PlaygroundOp.MASK, PlaygroundOp.HMAC,
              PlaygroundOp.HMAC_SHA512, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1,
              PlaygroundOp.MASK_TEMPLATE];
    case "LOW":
      return [PlaygroundOp.TOKENIZE, PlaygroundOp.MASK, PlaygroundOp.HMAC,
              PlaygroundOp.HMAC_SHA512, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1,
              PlaygroundOp.MASK_TEMPLATE];
    default: // UNCLASSIFIED
      return [PlaygroundOp.TOKENIZE, PlaygroundOp.MASK, PlaygroundOp.HMAC,
              PlaygroundOp.HMAC_SHA512, PlaygroundOp.AES256_GCM96, PlaygroundOp.FF3_1,
              PlaygroundOp.MASK_TEMPLATE];
  }
}

// ── Fallback canonical field defs (mirrors hardcoded defaults) ─────

const CANONICAL_FIELD_DEFS: FieldDefMeta[] = [
  { name: "ssn",             label: "SSN",              classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "***-**-####",         ...KNOWN_EXAMPLES.ssn             },
  { name: "card",            label: "Card Number",      classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "****-****-****-####",  ...KNOWN_EXAMPLES.card            },
  { name: "credit_card",     label: "Credit Card",      classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "****-****-****-####",  ...KNOWN_EXAMPLES.credit_card     },
  { name: "tax_id",          label: "Tax ID",           classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "**-*******",           ...KNOWN_EXAMPLES.tax_id          },
  { name: "bank_account",    label: "Bank Account",     classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "****####",             ...KNOWN_EXAMPLES.bank_account    },
  { name: "passport",        label: "Passport",         classification: "HIGH_SENSITIVE", allowed_operations: classificationToPlaygroundOps("HIGH_SENSITIVE"), template: "**#######",            ...KNOWN_EXAMPLES.passport        },
  { name: "email",           label: "Email",            classification: "MEDIUM",         allowed_operations: classificationToPlaygroundOps("MEDIUM"),         template: "j***@domain",          ...KNOWN_EXAMPLES.email           },
  { name: "phone",           label: "Phone",            classification: "MEDIUM",         allowed_operations: classificationToPlaygroundOps("MEDIUM"),         template: "***-***-####",         ...KNOWN_EXAMPLES.phone           },
  { name: "date_of_birth",   label: "Date of Birth",    classification: "MEDIUM",         allowed_operations: classificationToPlaygroundOps("MEDIUM"),         template: "####-**-**",           ...KNOWN_EXAMPLES.date_of_birth   },
  { name: "drivers_license", label: "Driver's License", classification: "MEDIUM",         allowed_operations: classificationToPlaygroundOps("MEDIUM"),         template: "**######",             ...KNOWN_EXAMPLES.drivers_license },
  { name: "name",            label: "Full Name",        classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "J*** D***",            ...KNOWN_EXAMPLES.name            },
  { name: "first_name",      label: "First Name",       classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "J***",                 ...KNOWN_EXAMPLES.first_name      },
  { name: "last_name",       label: "Last Name",        classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "D***",                 ...KNOWN_EXAMPLES.last_name       },
  { name: "address",         label: "Address",          classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "12*** Ma***",           ...KNOWN_EXAMPLES.address         },
  { name: "city",            label: "City",             classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "Ne***",                ...KNOWN_EXAMPLES.city            },
  { name: "zip_code",        label: "ZIP Code",         classification: "LOW",            allowed_operations: classificationToPlaygroundOps("LOW"),            template: "1****",                ...KNOWN_EXAMPLES.zip_code        },
];

// ── Fetch field defs from engine ───────────────────────────────────

async function fetchFieldDefs(): Promise<{ defs: FieldDefMeta[]; source: "live" | "fallback" }> {
  try {
    const res = await fetch(`${TNT_URL}/admin/rules`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return { defs: CANONICAL_FIELD_DEFS, source: "fallback" };

    const data = await res.json() as { rules?: Array<Record<string, unknown>> };
    if (!data.rules?.length) return { defs: CANONICAL_FIELD_DEFS, source: "fallback" };

    const defs: FieldDefMeta[] = data.rules.map((rule) => {
      const name = String(rule.name ?? "");
      const classification = String(rule.classification ?? "UNCLASSIFIED") as SensitivityLevel;
      const known = KNOWN_EXAMPLES[name];
      return {
        name,
        label: String(rule.description || name).replace(/_/g, " "),
        classification,
        allowed_operations: classificationToPlaygroundOps(classification),
        template: String(rule.template ?? ""),
        placeholder: known?.placeholder ?? `e.g. ${name}-value`,
        example: known?.example ?? `${name}-example`,
      };
    });

    // Always append a "custom" entry at the end
    defs.push({
      name: "custom",
      label: "Custom Field",
      classification: "UNCLASSIFIED",
      allowed_operations: classificationToPlaygroundOps("UNCLASSIFIED"),
      template: "##****##",
      placeholder: "Any value",
      example: "my-custom-value",
    });

    return { defs, source: "live" };
  } catch {
    return { defs: CANONICAL_FIELD_DEFS, source: "fallback" };
  }
}

// ── Handler ────────────────────────────────────────────────────────

export async function GET() {
  const { defs, source } = await fetchFieldDefs();

  // Build mask_templates map from field defs
  const maskTemplates: Record<string, string> = {};
  for (const d of defs) {
    if (d.template) maskTemplates[d.name] = d.template;
  }

  return NextResponse.json(
    {
      operations: OP_CATALOGUE,
      mask_templates: maskTemplates,
      field_defs: defs,
      source,
      fetched_at: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
      },
    },
  );
}
