// BFF: Transform Rules (FPE & Masking) — placeholder for Transit transform config
// GET: list current transform rules from T&T Engine
// This proxies to T&T Engine admin API for masking/transform configuration.

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const TNT_URL = process.env.TNT_ENGINE_URL || "http://localhost:8000";

export async function GET() {
  // Return the built-in transform rules from the T&T Engine governance layer
  // In a full implementation, this would query a config store
  return NextResponse.json([
    { name: "ssn_tokenize", type: "fpe", template: "***-**-####", tweak_source: "supplied", allowed_roles: ["tnt-engine"] },
    { name: "email_mask", type: "masking", template: "x***@domain", tweak_source: "internal", allowed_roles: ["tnt-engine"] },
    { name: "card_tokenize", type: "fpe", template: "****-****-****-####", tweak_source: "supplied", allowed_roles: ["tnt-engine"] },
    { name: "phone_mask", type: "masking", template: "***-***-####", tweak_source: "internal", allowed_roles: ["tnt-engine"] },
  ]);
}
