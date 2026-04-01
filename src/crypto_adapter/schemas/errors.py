"""Standardised error response schema for TT Crypto Adapter."""
import uuid
from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, Field


class ErrorCode(str, Enum):
    AUTH_FAILED = "AUTH_FAILED"
    CRYPTO_ERROR = "CRYPTO_ERROR"
    VAULT_UNAVAILABLE = "VAULT_UNAVAILABLE"
    CIRCUIT_OPEN = "CIRCUIT_OPEN"
    INVALID_INPUT = "INVALID_INPUT"
    INVALID_TOKEN = "INVALID_TOKEN"
    NOT_FOUND = "NOT_FOUND"


class ErrorResponse(BaseModel):
    error_code: ErrorCode
    message: str
    request_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
