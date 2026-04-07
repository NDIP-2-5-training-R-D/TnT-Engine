from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, Field


class Transformation(str, enum.Enum):
    TOKENIZE = "TOKENIZE"
    HMAC = "HMAC"
    MASK = "MASK"
    HMAC_SHA512 = "HMAC_SHA512"       # One-way HMAC-SHA-512 digest (via Transit)
    AES256_GCM96 = "AES256_GCM96"     # Authenticated encryption, 96-bit nonce (via Transit)
    FF3_1 = "FF3_1"                   # Format-Preserving Encryption NIST SP 800-38G (via Transit FPE key)
    MASK_TEMPLATE = "MASK_TEMPLATE"   # Custom masking template: # = reveal, * = mask


class TokenStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    REVOKED = "REVOKED"


class AuditAction(str, enum.Enum):
    TOKENIZE = "TOKENIZE"
    DETOKENIZE = "DETOKENIZE"
    BATCH_TOKENIZE = "BATCH_TOKENIZE"
    BATCH_DETOKENIZE = "BATCH_DETOKENIZE"
    REVOKE = "REVOKE"
    DELETE = "DELETE"
    REENCRYPT = "REENCRYPT"
    HMAC_SHA512 = "HMAC_SHA512"
    AES256_GCM96 = "AES256_GCM96"
    FF3_1 = "FF3_1"
    MASK_TEMPLATE = "MASK_TEMPLATE"


# ── Request / Response models ────────────────────────────────────────


class TokenizeRequest(BaseModel):
    value: str = Field(..., min_length=1)
    field: str = Field(..., min_length=1)
    transformation: Transformation = Transformation.TOKENIZE
    tenant_id: str = Field(..., min_length=1)
    ttl_seconds: int | None = None
    mask_template: str | None = None  # Required when transformation=MASK_TEMPLATE


class TokenizeResponse(BaseModel):
    token: str
    field: str
    cached: bool = False


class DetokenizeRequest(BaseModel):
    token: str = Field(..., min_length=1)
    tenant_id: str = Field(..., min_length=1)


class DetokenizeResponse(BaseModel):
    value: str
    field: str | None = None


class BatchTokenizeRequest(BaseModel):
    items: list[TokenizeRequest] = Field(..., min_length=1, max_length=1000)


class BatchTokenizeResponse(BaseModel):
    results: list[TokenizeResponse]


class BatchDetokenizeRequest(BaseModel):
    tokens: list[str] = Field(..., min_length=1, max_length=1000)
    tenant_id: str = Field(..., min_length=1)


class BatchDetokenizeResponse(BaseModel):
    results: list[DetokenizeResponse]


class RevokeRequest(BaseModel):
    token: str = Field(..., min_length=1)
    tenant_id: str = Field(..., min_length=1)


class DeleteRequest(BaseModel):
    token: str = Field(..., min_length=1)
    tenant_id: str = Field(..., min_length=1)


# ── Internal domain objects ──────────────────────────────────────────


class TokenRecord(BaseModel):
    token: str
    value_encrypted: str
    transformation: str
    key_version: int
    tenant_id: str
    status: str
    expires_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class TokenLookupRecord(BaseModel):
    hash: str
    tenant_id: str
    token: str


class AuditEntry(BaseModel):
    action: AuditAction
    field: str | None = None
    tenant_id: str = ""
    trace_id: str | None = None
    status: str = "success"  # "success" or "failure"
    metadata: dict = Field(default_factory=dict)
