from pydantic import BaseModel, Field
from typing import List, Optional, Any


# ── Transform / Role ─────────────────────────────────────────────────────────

class RoleCreateRequest(BaseModel):
    transformations: List[str] = Field(..., examples=[["fpe-ssn", "token-cc"]])


# ── Transform / Template ─────────────────────────────────────────────────────

class TemplateCreateRequest(BaseModel):
    type: str = Field(..., examples=["regex"])
    pattern: Optional[str] = None


# ── Transform / Transformations ───────────────────────────────────────────────

class MaskingTransformRequest(BaseModel):
    type: str = "masking"
    template: str
    masking_character: str = "X"
    allowed_roles: List[str] = []


class FPETransformRequest(BaseModel):
    type: str = "fpe"
    alphabet: str = "numeric"
    tweak_source: str = "internal"
    allowed_roles: List[str] = []


class TokenizationTransformRequest(BaseModel):
    type: str = "tokenization"
    mapping_mode: str = "default"
    convergent: bool = False
    allowed_roles: List[str] = []
    store: str = "postgres"


# ── Transform / Alphabet ──────────────────────────────────────────────────────

class AlphabetCreateRequest(BaseModel):
    alphabet: str = Field(..., examples=["0123456789"])


# ── Transform / Encode & Decode ───────────────────────────────────────────────

class EncodeRequest(BaseModel):
    value: str
    transformation: str


class DecodeRequest(BaseModel):
    value: str
    transformation: str


# ── Transit ───────────────────────────────────────────────────────────────────

class TransitKeyCreateRequest(BaseModel):
    type: str = Field("aes256-gcm96", examples=["aes256-gcm96", "rsa-2048", "ecdsa-p256"])


class TransitEncryptRequest(BaseModel):
    plaintext: str = Field(..., description="Base64-encoded plaintext")


class TransitDecryptRequest(BaseModel):
    ciphertext: str = Field(..., description="vault:v1:... format")


class TransitSignRequest(BaseModel):
    input: str = Field(..., description="Base64-encoded input")


class TransitVerifyRequest(BaseModel):
    input: str = Field(..., description="Base64-encoded input")
    signature: str


# ── Process API ───────────────────────────────────────────────────────────────

class FieldItem(BaseModel):
    name: str
    value: Any
    transformation: Optional[str] = None


class ProcessRequest(BaseModel):
    role: str
    fields: List[FieldItem] = Field(..., min_length=1)


class BatchProcessRequest(BaseModel):
    items: List[ProcessRequest] = Field(..., min_length=1)
