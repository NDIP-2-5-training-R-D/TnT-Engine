/**
 * PII field classification — mirrors governance/classification.py exactly.
 * Extracted as a pure utility for use in BFF routes and unit tests.
 */

import type { SensitivityLevel } from "./types";

export interface Classification {
  level: SensitivityLevel;
  allowed: string[];
}

/** Canonical field → classification map (mirrors classification.py). */
export const CLASSIFICATION_MAP: Record<string, Classification> = {
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

/** Classify a field type. Returns UNCLASSIFIED for unknown fields. */
export function classifyField(fieldType: string): Classification {
  return CLASSIFICATION_MAP[fieldType.toLowerCase()] ?? UNCLASSIFIED;
}

/**
 * Check if an operation is allowed for a field type.
 * Returns null if allowed, or an error message string if denied.
 */
export function checkGovernance(fieldType: string, operation: string): string | null {
  if (operation === "DETOKENIZE") return null; // always allowed
  const c = classifyField(fieldType);
  if (c.allowed.includes(operation)) return null;
  return `Operation '${operation}' is not permitted for field '${fieldType}' (${c.level}). Allowed: ${c.allowed.join(", ")}`;
}
