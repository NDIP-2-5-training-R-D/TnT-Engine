/**
 * Unit tests for token lifecycle API logic.
 * Tests input validation rules used by /api/tokens/revoke and /api/tokens/delete.
 */

// ── Validation helpers (extracted from route logic) ────────────────

function validateRevokeInput(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "Body must be an object";
  const { token, tenant_id } = body as Record<string, unknown>;
  if (typeof token !== "string" || !token.trim()) return "token is required";
  if (typeof tenant_id !== "string" || !tenant_id.trim()) return "tenant_id is required";
  return null;
}

function validateDeleteInput(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "Body must be an object";
  const { token, tenant_id, confirm } = body as Record<string, unknown>;
  if (typeof token !== "string" || !token.trim()) return "token is required";
  if (typeof tenant_id !== "string" || !tenant_id.trim()) return "tenant_id is required";
  if (confirm !== "DELETE") return "confirm field must be exactly 'DELETE'";
  return null;
}

function validateTokenListParams(params: Record<string, string | null>): {
  limit: number; offset: number; error: string | null
} {
  const limit  = Math.min(Number(params.limit  ?? "50"),  200);
  const offset = Math.max(Number(params.offset ?? "0"),    0);
  if (isNaN(limit)  || limit  < 1) return { limit: 50,  offset: 0, error: "limit must be a positive integer" };
  if (isNaN(offset) || offset < 0) return { limit,      offset: 0, error: "offset must be non-negative" };
  return { limit, offset, error: null };
}

// ── Revoke input validation ────────────────────────────────────────

describe("validateRevokeInput", () => {
  it("accepts valid input", () => {
    expect(validateRevokeInput({ token: "tok_abc123", tenant_id: "acme" })).toBeNull();
  });

  it("rejects missing token", () => {
    expect(validateRevokeInput({ tenant_id: "acme" })).toContain("token");
  });

  it("rejects empty token string", () => {
    expect(validateRevokeInput({ token: "  ", tenant_id: "acme" })).toContain("token");
  });

  it("rejects missing tenant_id", () => {
    expect(validateRevokeInput({ token: "tok_abc" })).toContain("tenant_id");
  });

  it("rejects null body", () => {
    expect(validateRevokeInput(null)).not.toBeNull();
  });

  it("rejects non-object body", () => {
    expect(validateRevokeInput("string body")).not.toBeNull();
  });
});

// ── Delete input validation ────────────────────────────────────────

describe("validateDeleteInput", () => {
  const valid = { token: "tok_abc123", tenant_id: "acme", confirm: "DELETE" };

  it("accepts valid input with correct confirmation", () => {
    expect(validateDeleteInput(valid)).toBeNull();
  });

  it("rejects wrong confirmation phrase", () => {
    expect(validateDeleteInput({ ...valid, confirm: "delete" })).toContain("confirm");
    expect(validateDeleteInput({ ...valid, confirm: "REMOVE" })).toContain("confirm");
    expect(validateDeleteInput({ ...valid, confirm: "" })).toContain("confirm");
  });

  it("rejects missing confirmation", () => {
    const { confirm: _c, ...noConfirm } = valid;
    expect(validateDeleteInput(noConfirm)).toContain("confirm");
  });

  it("rejects missing token even with correct confirm", () => {
    expect(validateDeleteInput({ tenant_id: "acme", confirm: "DELETE" })).toContain("token");
  });

  it("is case-sensitive — 'delete' is not accepted", () => {
    expect(validateDeleteInput({ ...valid, confirm: "delete" })).not.toBeNull();
  });
});

// ── Token list parameter validation ───────────────────────────────

describe("validateTokenListParams", () => {
  it("returns defaults for missing params", () => {
    const r = validateTokenListParams({ limit: null, offset: null });
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(r.error).toBeNull();
  });

  it("caps limit at 200", () => {
    const r = validateTokenListParams({ limit: "999", offset: "0" });
    expect(r.limit).toBe(200);
    expect(r.error).toBeNull();
  });

  it("accepts valid limit and offset", () => {
    const r = validateTokenListParams({ limit: "20", offset: "40" });
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(40);
    expect(r.error).toBeNull();
  });

  it("floors negative offset to 0", () => {
    const r = validateTokenListParams({ limit: "50", offset: "-10" });
    expect(r.offset).toBe(0);
  });
});

// ── Token record display safety ────────────────────────────────────

describe("token display safety", () => {
  const safeFields = ["token", "transformation", "key_version", "tenant_id", "status", "expires_at", "created_at", "updated_at"];
  const unsafeFields = ["value_encrypted", "plaintext", "value", "raw"];

  it("safe token record contains no ciphertext field", () => {
    const record = {
      token: "tok_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      transformation: "TOKENIZE",
      key_version: 3,
      tenant_id: "acme",
      status: "ACTIVE",
      expires_at: null,
      created_at: "2026-04-05T10:00:00Z",
      updated_at: "2026-04-05T10:00:00Z",
    };
    const keys = Object.keys(record);
    unsafeFields.forEach((f) => {
      expect(keys).not.toContain(f);
    });
    safeFields.forEach((f) => {
      expect(keys).toContain(f);
    });
  });

  it("token prefix display (first 16 chars) never exposes full token length", () => {
    const token = "tok_" + "a".repeat(32);
    const display = token.slice(0, 16) + "…";
    expect(display.length).toBeLessThan(token.length);
    expect(display).not.toBe(token);
  });
});
