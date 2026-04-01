from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
import uuid


# ── Generic wrapper ───────────────────────────────────────────────────────────

class FieldResult(BaseModel):
    original: Any
    result: Any
    steps_applied: List[str] = []
    errors: List[str] = []


class ProcessResponse(BaseModel):
    status: str  # "success" | "partial" | "error"
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    results: Dict[str, FieldResult] = {}
    errors: List[str] = []


class BatchItemResult(BaseModel):
    role: str
    status: str
    results: Dict[str, FieldResult] = {}
    errors: List[str] = []


class BatchProcessResponse(BaseModel):
    status: str
    total: int
    succeeded: int
    failed: int
    results: List[BatchItemResult] = []
    errors: List[str] = []


# ── Role / Template / Transformation ─────────────────────────────────────────

class GenericResponse(BaseModel):
    status: str = "ok"
    data: Optional[Any] = None


class ListResponse(BaseModel):
    keys: List[str] = []


# ── Transit ───────────────────────────────────────────────────────────────────

class TransitEncryptResponse(BaseModel):
    ciphertext: str


class TransitDecryptResponse(BaseModel):
    plaintext: str


class TransitSignResponse(BaseModel):
    signature: str


class TransitVerifyResponse(BaseModel):
    valid: bool


# ── Health ────────────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = "0.1.0"
