import { classifyField, checkGovernance, CLASSIFICATION_MAP } from "../classification";

// ── classifyField ──────────────────────────────────────────────────

describe("classifyField", () => {
  // HIGH_SENSITIVE
  it.each(["ssn", "card", "credit_card", "tax_id", "bank_account", "passport"])(
    "classifies %s as HIGH_SENSITIVE", (field) => {
      const c = classifyField(field);
      expect(c.level).toBe("HIGH_SENSITIVE");
      expect(c.allowed).toEqual(["TOKENIZE"]);
    },
  );

  // MEDIUM
  it.each(["email", "phone", "date_of_birth", "drivers_license"])(
    "classifies %s as MEDIUM", (field) => {
      const c = classifyField(field);
      expect(c.level).toBe("MEDIUM");
      expect(c.allowed).toContain("TOKENIZE");
      expect(c.allowed).toContain("MASK");
      expect(c.allowed).toContain("HMAC");
    },
  );

  // LOW
  it.each(["name", "first_name", "last_name", "address", "city", "zip_code"])(
    "classifies %s as LOW", (field) => {
      const c = classifyField(field);
      expect(c.level).toBe("LOW");
      expect(c.allowed).toContain("PASSTHROUGH");
    },
  );

  it("is case-insensitive for field lookup", () => {
    expect(classifyField("SSN").level).toBe("HIGH_SENSITIVE");
    expect(classifyField("Email").level).toBe("MEDIUM");
    expect(classifyField("NAME").level).toBe("LOW");
  });

  it("returns UNCLASSIFIED for unknown field", () => {
    const c = classifyField("my_custom_field");
    expect(c.level).toBe("UNCLASSIFIED");
    expect(c.allowed).toContain("TOKENIZE");
    expect(c.allowed).not.toContain("PASSTHROUGH");
  });
});

// ── checkGovernance ────────────────────────────────────────────────

describe("checkGovernance", () => {
  it("allows TOKENIZE for HIGH_SENSITIVE fields", () => {
    expect(checkGovernance("ssn", "TOKENIZE")).toBeNull();
    expect(checkGovernance("card", "TOKENIZE")).toBeNull();
  });

  it("denies MASK for HIGH_SENSITIVE fields", () => {
    const err = checkGovernance("ssn", "MASK");
    expect(err).not.toBeNull();
    expect(err).toContain("MASK");
    expect(err).toContain("HIGH_SENSITIVE");
  });

  it("denies HMAC for HIGH_SENSITIVE fields", () => {
    expect(checkGovernance("passport", "HMAC")).not.toBeNull();
  });

  it("allows MASK and HMAC for MEDIUM fields", () => {
    expect(checkGovernance("email", "MASK")).toBeNull();
    expect(checkGovernance("phone", "HMAC")).toBeNull();
    expect(checkGovernance("date_of_birth", "TOKENIZE")).toBeNull();
  });

  it("denies PASSTHROUGH for MEDIUM fields", () => {
    expect(checkGovernance("email", "PASSTHROUGH")).not.toBeNull();
  });

  it("allows all operations for LOW fields", () => {
    expect(checkGovernance("name", "TOKENIZE")).toBeNull();
    expect(checkGovernance("name", "MASK")).toBeNull();
    expect(checkGovernance("name", "HMAC")).toBeNull();
    expect(checkGovernance("address", "PASSTHROUGH")).toBeNull();
  });

  it("allows DETOKENIZE for any field type (always allowed)", () => {
    expect(checkGovernance("ssn",     "DETOKENIZE")).toBeNull();
    expect(checkGovernance("email",   "DETOKENIZE")).toBeNull();
    expect(checkGovernance("unknown", "DETOKENIZE")).toBeNull();
  });

  it("returns descriptive error message including allowed ops", () => {
    const err = checkGovernance("ssn", "MASK");
    expect(err).toMatch(/TOKENIZE/);
    expect(err).toMatch(/ssn/);
    expect(err).toMatch(/HIGH_SENSITIVE/);
  });
});

// ── CLASSIFICATION_MAP completeness ───────────────────────────────

describe("CLASSIFICATION_MAP", () => {
  it("contains exactly 16 field types", () => {
    expect(Object.keys(CLASSIFICATION_MAP)).toHaveLength(16);
  });

  it("has 6 HIGH_SENSITIVE fields", () => {
    const count = Object.values(CLASSIFICATION_MAP).filter((c) => c.level === "HIGH_SENSITIVE").length;
    expect(count).toBe(6);
  });

  it("has 4 MEDIUM fields", () => {
    const count = Object.values(CLASSIFICATION_MAP).filter((c) => c.level === "MEDIUM").length;
    expect(count).toBe(4);
  });

  it("has 6 LOW fields", () => {
    const count = Object.values(CLASSIFICATION_MAP).filter((c) => c.level === "LOW").length;
    expect(count).toBe(6);
  });

  it("all HIGH_SENSITIVE fields only allow TOKENIZE", () => {
    Object.entries(CLASSIFICATION_MAP)
      .filter(([, c]) => c.level === "HIGH_SENSITIVE")
      .forEach(([field, c]) => {
        expect(c.allowed).toEqual(["TOKENIZE"]);
        // Sanity check: no masking allowed for these
        expect(c.allowed).not.toContain("MASK");
        expect(c.allowed).not.toContain("PASSTHROUGH");
      });
  });

  it("no MEDIUM or HIGH_SENSITIVE field allows PASSTHROUGH", () => {
    Object.entries(CLASSIFICATION_MAP)
      .filter(([, c]) => c.level !== "LOW")
      .forEach(([field, c]) => {
        expect(c.allowed).not.toContain("PASSTHROUGH");
      });
  });
});
