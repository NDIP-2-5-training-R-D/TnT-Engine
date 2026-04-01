import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app

HEADERS = {"X-Vault-Token": "mock-vault-token"}
BAD_HEADERS = {"X-Vault-Token": "wrong-token"}


@pytest.mark.asyncio
async def test_health():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_auth_required():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/v1/transform/role", headers=BAD_HEADERS)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_and_get_role():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        create = await client.post(
            "/v1/transform/role/my-role",
            json={"transformations": ["fpe-ssn", "token-cc"]},
            headers=HEADERS,
        )
        assert create.status_code == 200

        get = await client.get("/v1/transform/role/my-role", headers=HEADERS)
        assert get.status_code == 200
        assert get.json()["data"]["transformations"] == ["fpe-ssn", "token-cc"]


@pytest.mark.asyncio
async def test_process_endpoint():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/process",
            json={
                "role": "test-role",
                "fields": [
                    {"name": "card_number", "value": "4111111111111111", "transformation": "token-cc"},
                    {"name": "name", "value": "John Doe", "transformation": None},
                ],
            },
            headers=HEADERS,
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in ("success", "partial", "error")
    assert "request_id" in body


@pytest.mark.asyncio
async def test_batch_process_endpoint():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/process/batch",
            json={
                "items": [
                    {
                        "role": "test-role",
                        "fields": [{"name": "card_number", "value": "4111111111111111", "transformation": "token-cc"}],
                    },
                    {
                        "role": "default-role",
                        "fields": [{"name": "email", "value": "test@example.com", "transformation": None}],
                    },
                ]
            },
            headers=HEADERS,
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert "succeeded" in body
    assert "failed" in body


@pytest.mark.asyncio
async def test_transit_encrypt_decrypt():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        enc = await client.post(
            "/v1/transit/encrypt/my-key",
            json={"plaintext": "aGVsbG8="},
            headers=HEADERS,
        )
        assert enc.status_code == 200
        ciphertext = enc.json()["ciphertext"]
        assert ciphertext.startswith("vault:v1:")

        dec = await client.post(
            "/v1/transit/decrypt/my-key",
            json={"ciphertext": ciphertext},
            headers=HEADERS,
        )
        assert dec.status_code == 200
        assert dec.json()["plaintext"] == "aGVsbG8="
