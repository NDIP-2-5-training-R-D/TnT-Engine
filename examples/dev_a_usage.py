"""
Example: How Dev A uses the T&T Engine SDK.

Dev A is a business application developer. They do NOT need to understand:
  - Database schemas
  - Redis caching
  - Encryption algorithms
  - Connection pooling
  - Retry logic

They only use the SDK's clean interface.
"""

import asyncio
from tnt_engine.sdk import TNTClient


async def main():
    # ── Initialize (once at app startup) ─────────────────────────
    client = await TNTClient.create()

    tenant = "acme_corp"

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 1: Simple tokenize/detokenize
    # ─────────────────────────────────────────────────────────────

    token = await client.tokenize(
        value="123-45-6789",
        field_type="ssn",
        tenant_id=tenant,
    )
    print(f"Token: {token}")  # tok_Abc123...

    original = await client.detokenize(token, tenant_id=tenant)
    print(f"Original: {original}")  # 123-45-6789

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 2: Batch tokenization (efficient — deduplicates + batches)
    # ─────────────────────────────────────────────────────────────

    tokens = await client.tokenize_batch(
        items=[
            ("john@acme.com", "email"),
            ("555-12-3456", "ssn"),
            ("john@acme.com", "email"),  # duplicate — returns same token
        ],
        tenant_id=tenant,
    )
    print(f"Batch tokens: {tokens}")
    assert tokens[0] == tokens[2]  # convergent tokenization

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 3: Masking (synchronous, one-way, no DB)
    # ─────────────────────────────────────────────────────────────

    masked_email = client.mask("john@acme.com", field_type="email")
    print(f"Masked email: {masked_email}")  # j***@acme.com

    masked_ssn = client.mask("123-45-6789", field_type="ssn")
    print(f"Masked SSN: {masked_ssn}")  # ***-**-6789

    masked_card = client.mask("4111111111111111", field_type="card")
    print(f"Masked card: {masked_card}")  # ****-****-****-1111

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 4: Policy-driven processing (recommended for Dev A)
    # ─────────────────────────────────────────────────────────────

    # Process a single field
    result = await client.process_field(
        policy={"field": "ssn", "action": "TOKENIZE"},
        value="123-45-6789",
        tenant_id=tenant,
    )
    print(f"Policy result: {result.field}={result.transformed_value}")

    # Process an entire record — TOKENIZE fields are batched automatically
    results = await client.process_record(
        policies=[
            {"field": "ssn", "action": "TOKENIZE"},
            {"field": "email", "action": "MASK"},
            {"field": "name", "action": "MASK"},
            {"field": "account_id", "action": "PASSTHROUGH"},
        ],
        values={
            "ssn": "123-45-6789",
            "email": "john@acme.com",
            "name": "John Doe",
            "account_id": "A001",
        },
        tenant_id=tenant,
    )
    for field, r in results.items():
        print(f"  {field}: {r.action} → {r.transformed_value}")
    # ssn:        TOKENIZE    → tok_Abc123...
    # email:      MASK         → j***@acme.com
    # name:       MASK         → J*** D***
    # account_id: PASSTHROUGH  → A001

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 5: Token lifecycle
    # ─────────────────────────────────────────────────────────────

    token = await client.tokenize("temp-value", "temp", tenant)

    # Revoke — token can no longer be detokenized
    await client.revoke(token, tenant_id=tenant)

    # Delete — GDPR right to erasure, hard delete from all storage
    token2 = await client.tokenize("delete-me", "pii", tenant)
    await client.delete(token2, tenant_id=tenant)

    # ─────────────────────────────────────────────────────────────
    # EXAMPLE 6: Auto-expiring tokens
    # ─────────────────────────────────────────────────────────────

    temp_token = await client.tokenize(
        value="one-time-code",
        field_type="otp",
        tenant_id=tenant,
        ttl_seconds=300,  # expires after 5 minutes
    )
    print(f"Temp token (5min TTL): {temp_token}")

    # ── Cleanup ──────────────────────────────────────────────────
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
