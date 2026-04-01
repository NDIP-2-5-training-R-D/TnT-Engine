"""Structured error hierarchy for the T&T Engine."""

from __future__ import annotations


class TNTError(Exception):
    """Base error for all T&T Engine operations."""

    code: str = "TNT_INTERNAL_ERROR"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(message)


class TokenNotFoundError(TNTError):
    code = "TOKEN_NOT_FOUND"

    def __init__(self, token: str) -> None:
        super().__init__(f"Token not found: {token[:12]}...", details={"token_prefix": token[:12]})


class InvalidTokenFormatError(TNTError):
    code = "INVALID_TOKEN_FORMAT"

    def __init__(self, token: str) -> None:
        super().__init__(
            "Token does not match expected format",
            details={"token_prefix": token[:12] if token else ""},
        )


class TokenRevokedError(TNTError):
    code = "TOKEN_REVOKED"

    def __init__(self, token: str) -> None:
        super().__init__(
            f"Token has been revoked: {token[:12]}...",
            details={"token_prefix": token[:12]},
        )


class TokenExpiredError(TNTError):
    code = "TOKEN_EXPIRED"

    def __init__(self, token: str) -> None:
        super().__init__(
            f"Token has expired: {token[:12]}...",
            details={"token_prefix": token[:12]},
        )


class TenantRequiredError(TNTError):
    code = "TENANT_REQUIRED"

    def __init__(self) -> None:
        super().__init__("tenant_id is required for all operations")


class EncryptionError(TNTError):
    code = "ENCRYPTION_FAILED"

    def __init__(self, operation: str, cause: str = "") -> None:
        super().__init__(
            f"Encryption operation failed: {operation}",
            details={"operation": operation, "cause": cause},
        )


class CryptoServiceUnavailableError(TNTError):
    code = "CRYPTO_SERVICE_UNAVAILABLE"

    def __init__(self) -> None:
        super().__init__("Crypto service is unavailable (circuit open)")


class DatabaseError(TNTError):
    code = "DATABASE_ERROR"

    def __init__(self, operation: str, cause: str = "") -> None:
        super().__init__(
            f"Database operation failed: {operation}",
            details={"operation": operation, "cause": cause},
        )
