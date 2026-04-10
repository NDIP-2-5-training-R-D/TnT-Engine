/**
 * PII field classification — mirrors governance/classification.py exactly.
 * Extracted as a pure utility for use in BFF routes and unit tests.
 *
 * Source of truth: cp_field_classifications table (postgres mode)
 *                  or /tmp/tnt-classification.json (file mode, default)
 * Fallback when store not yet loaded: CLASSIFICATION_SEED (same values as before).
 */

import type { SensitivityLevel } from "./types";
import {
  classifyFieldSync,
  CLASSIFICATION_SEED,
  UNCLASSIFIED,
  type Classification,
} from "./classification-store";

export type { Classification };

/**
 * CLASSIFICATION_MAP is kept for backward compatibility.
 * It reflects the current in-memory cache (seeded from DB / file on startup).
 * Use classifyField() for live lookups.
 */
export const CLASSIFICATION_MAP: Record<string, Classification> = CLASSIFICATION_SEED;

/** Classify a field type. Returns UNCLASSIFIED for unknown fields. */
export function classifyField(fieldType: string): Classification {
  return classifyFieldSync(fieldType);
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

export { UNCLASSIFIED };
export type { SensitivityLevel };
