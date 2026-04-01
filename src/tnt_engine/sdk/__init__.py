"""T&T Engine SDK — clean interface for other services.

Usage:
    from tnt_engine.sdk import TNTClient

    client = await TNTClient.create(settings)
    token = await client.tokenize("123-45-6789", field_type="ssn", tenant_id="acme")
    value = await client.detokenize(token, tenant_id="acme")
    await client.close()
"""

from tnt_engine.sdk.client import TNTClient

__all__ = ["TNTClient"]
