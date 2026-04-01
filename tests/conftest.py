"""Test fixtures — in-memory fakes for all infrastructure layers.

Simulates:
  - Crypto: deterministic HMAC + base64 "encryption"
  - Repository: in-memory with concurrency-safe upsert + lifecycle + dedup
  - Cache: layered L1+L2 (both in-memory for tests)
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone

import pytest

from tnt_engine.config import Settings
from tnt_engine.crypto.interface import CryptoBackend
from tnt_engine.models.domain import TokenRecord, TokenStatus
from tnt_engine.service.token_service import TokenService


# ── Fake crypto backend ──────────────────────────────────────────────


class FakeCryptoBackend(CryptoBackend):
    def __init__(self) -> None:
        self.hmac_call_count = 0
        self.encrypt_call_count = 0
        self.decrypt_call_count = 0

    async def hmac(self, plaintext: str, key_name: str | None = None) -> str:
        self.hmac_call_count += 1
        return hashlib.sha256(plaintext.encode()).hexdigest()

    async def encrypt(self, plaintext: str, key_name: str | None = None) -> tuple[str, int]:
        self.encrypt_call_count += 1
        b64 = base64.b64encode(plaintext.encode()).decode()
        return f"vault:v1:{b64}", 1

    async def decrypt(
        self, ciphertext: str, key_version: int, key_name: str | None = None
    ) -> str:
        self.decrypt_call_count += 1
        b64 = ciphertext.split(":", 2)[2]
        return base64.b64decode(b64).decode()

    async def close(self) -> None:
        pass


# ── Fake repository ──────────────────────────────────────────────────


class FakeTokenRepository:
    def __init__(self) -> None:
        self.token_store: dict[str, dict] = {}
        self.token_lookup: dict[tuple[str, str], str] = {}  # (hash, tenant_id) → token
        self.audit_entries: list = []
        self.dedup_store: dict[tuple[str, str], dict] = {}

    # -- lookup --

    async def find_token_by_hash(self, hmac_hash: str, tenant_id: str) -> str | None:
        return self.token_lookup.get((hmac_hash, tenant_id))

    async def find_tokens_by_hashes(
        self, hmac_hashes: list[str], tenant_id: str
    ) -> dict[str, str]:
        return {
            h: self.token_lookup[(h, tenant_id)]
            for h in hmac_hashes
            if (h, tenant_id) in self.token_lookup
        }

    # -- store --

    async def get_token_record(self, token: str, tenant_id: str) -> TokenRecord | None:
        rec = self.token_store.get(token)
        if not rec or rec["tenant_id"] != tenant_id:
            return None
        return TokenRecord(
            token=token,
            value_encrypted=rec["value_encrypted"],
            transformation=rec["transformation"],
            key_version=rec["key_version"],
            tenant_id=rec["tenant_id"],
            status=rec.get("status", "ACTIVE"),
            expires_at=rec.get("expires_at"),
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )

    async def get_token_records(
        self, tokens: list[str], tenant_id: str
    ) -> dict[str, TokenRecord]:
        result = {}
        for t in tokens:
            rec = await self.get_token_record(t, tenant_id)
            if rec:
                result[t] = rec
        return result

    # -- upsert (concurrency-safe) --

    async def upsert_token(
        self,
        token: str,
        value_encrypted: str,
        transformation: str,
        key_version: int,
        hmac_hash: str,
        tenant_id: str,
        expires_at: datetime | None = None,
    ) -> str:
        key = (hmac_hash, tenant_id)
        existing = self.token_lookup.get(key)
        if existing is not None:
            return existing
        self.token_store[token] = {
            "value_encrypted": value_encrypted,
            "transformation": transformation,
            "key_version": key_version,
            "tenant_id": tenant_id,
            "status": "ACTIVE",
            "expires_at": expires_at,
        }
        self.token_lookup[key] = token
        return token

    async def batch_upsert_tokens(
        self, records: list[tuple[str, str, str, int, str, str, datetime | None]]
    ) -> dict[str, str]:
        results: dict[str, str] = {}
        for token, enc, trans, kv, h, tid, exp in records:
            winner = await self.upsert_token(token, enc, trans, kv, h, tid, exp)
            results[h] = winner
        return results

    # -- lifecycle --

    async def revoke_token(self, token: str, tenant_id: str) -> bool:
        rec = self.token_store.get(token)
        if not rec or rec["tenant_id"] != tenant_id or rec["status"] != "ACTIVE":
            return False
        rec["status"] = "REVOKED"
        return True

    async def delete_token(self, token: str, tenant_id: str) -> bool:
        rec = self.token_store.get(token)
        if not rec or rec["tenant_id"] != tenant_id:
            return False
        del self.token_store[token]
        # Remove from lookup
        to_remove = [k for k, v in self.token_lookup.items() if v == token]
        for k in to_remove:
            del self.token_lookup[k]
        return True

    async def expire_stale_tokens(self, batch_size: int = 1000) -> int:
        now = datetime.now(timezone.utc)
        count = 0
        for rec in self.token_store.values():
            if (
                rec["status"] == "ACTIVE"
                and rec.get("expires_at")
                and rec["expires_at"] < now
            ):
                rec["status"] = "EXPIRED"
                count += 1
                if count >= batch_size:
                    break
        return count

    async def get_tokens_for_reencrypt(
        self, max_key_version: int, batch_size: int = 500
    ) -> list[TokenRecord]:
        results = []
        for token, rec in self.token_store.items():
            if rec["key_version"] < max_key_version and rec["status"] == "ACTIVE":
                results.append(
                    TokenRecord(
                        token=token,
                        value_encrypted=rec["value_encrypted"],
                        transformation=rec["transformation"],
                        key_version=rec["key_version"],
                        tenant_id=rec["tenant_id"],
                        status=rec["status"],
                        expires_at=rec.get("expires_at"),
                        created_at=datetime.now(timezone.utc),
                        updated_at=datetime.now(timezone.utc),
                    )
                )
                if len(results) >= batch_size:
                    break
        return results

    async def update_encrypted_value(
        self, token: str, value_encrypted: str, key_version: int
    ) -> None:
        rec = self.token_store.get(token)
        if rec:
            rec["value_encrypted"] = value_encrypted
            rec["key_version"] = key_version

    # -- cache rebuild --

    async def get_active_lookups_batch(
        self, offset: int, limit: int
    ) -> list[tuple[str, str, str]]:
        results = []
        items = list(self.token_lookup.items())
        for (h, tid), token in items[offset:offset + limit]:
            rec = self.token_store.get(token)
            if rec and rec.get("status", "ACTIVE") == "ACTIVE":
                results.append((h, tid, token))
        return results

    # -- dedup --

    async def get_dedup(self, request_hash: str, tenant_id: str) -> dict | None:
        return self.dedup_store.get((request_hash, tenant_id))

    async def set_dedup(self, request_hash: str, tenant_id: str, response: dict) -> None:
        self.dedup_store[(request_hash, tenant_id)] = response

    async def cleanup_dedup(self, max_age_seconds: int = 3600) -> int:
        count = len(self.dedup_store)
        self.dedup_store.clear()
        return count

    # -- audit --

    async def write_audit(self, entry: object) -> None:
        self.audit_entries.append(entry)

    async def write_audit_batch(self, entries: list) -> None:
        self.audit_entries.extend(entries)


# ── Fake layered cache ───────────────────────────────────────────────


class FakeLayeredCache:
    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def _key(self, tenant_id: str, hmac_hash: str) -> str:
        return f"{tenant_id}:{hmac_hash}"

    async def get(self, hmac_hash: str, tenant_id: str) -> str | None:
        return self._data.get(self._key(tenant_id, hmac_hash))

    async def set(self, hmac_hash: str, tenant_id: str, token: str) -> None:
        self._data[self._key(tenant_id, hmac_hash)] = token

    async def get_multi(
        self, hmac_hashes: list[str], tenant_id: str
    ) -> dict[str, str | None]:
        return {h: self._data.get(self._key(tenant_id, h)) for h in hmac_hashes}

    async def set_multi(self, mapping: dict[str, str], tenant_id: str) -> None:
        for h, tok in mapping.items():
            self._data[self._key(tenant_id, h)] = tok

    async def delete(self, hmac_hash: str, tenant_id: str) -> None:
        self._data.pop(self._key(tenant_id, hmac_hash), None)

    async def close(self) -> None:
        pass

    def clear(self) -> None:
        self._data.clear()

    @property
    def l1_size(self) -> int:
        return len(self._data)


# ── Fixtures ─────────────────────────────────────────────────────────

TENANT = "test_tenant"


@pytest.fixture
def settings() -> Settings:
    return Settings()


@pytest.fixture
def fake_crypto() -> FakeCryptoBackend:
    return FakeCryptoBackend()


@pytest.fixture
def fake_repo() -> FakeTokenRepository:
    return FakeTokenRepository()


@pytest.fixture
def fake_cache() -> FakeLayeredCache:
    return FakeLayeredCache()


@pytest.fixture
def token_service(
    fake_crypto: FakeCryptoBackend,
    fake_repo: FakeTokenRepository,
    fake_cache: FakeLayeredCache,
    settings: Settings,
) -> TokenService:
    return TokenService(
        hmac=fake_crypto,         # type: ignore[arg-type]
        encryption=fake_crypto,   # type: ignore[arg-type]
        repo=fake_repo,           # type: ignore[arg-type]
        cache=fake_cache,         # type: ignore[arg-type]
        settings=settings,
    )
