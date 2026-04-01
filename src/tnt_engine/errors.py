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


class VaultAuthError(TNTError):
    """Failed to authenticate to OpenBao/Vault."""

    code = "VAULT_AUTH_FAILED"

    def __init__(self, method: str, cause: str = "") -> None:
        super().__init__(
            f"Vault authentication failed: {method}",
            details={"method": method, "cause": cause},
        )


class VaultTokenExpiredError(TNTError):
    """OpenBao/Vault token has expired and renewal failed."""

    code = "VAULT_TOKEN_EXPIRED"

    def __init__(self) -> None:
        super().__init__("Vault token has expired and could not be renewed")


class EnvironmentSafetyError(TNTError):
    """Raised when a configuration violates environment safety rules."""

    code = "ENVIRONMENT_SAFETY_VIOLATION"

    def __init__(self, message: str) -> None:
        super().__init__(message)


class HSMError(TNTError):
    """Base error for HSM/PKCS#11 operations."""

    code = "HSM_ERROR"

    def __init__(self, operation: str, cause: str = "") -> None:
        super().__init__(
            f"HSM operation failed: {operation}",
            details={"operation": operation, "cause": cause},
        )


class HSMSessionError(HSMError):
    """Failed to open or maintain a PKCS#11 session."""

    code = "HSM_SESSION_ERROR"


class HSMKeyNotFoundError(HSMError):
    """Requested key label not found in HSM slot."""

    code = "HSM_KEY_NOT_FOUND"

    def __init__(self, label: str) -> None:
        super().__init__("key_lookup", cause=f"Key label not found: {label}")


class HSMAuthenticationError(HSMError):
    """PIN authentication to HSM slot failed."""

    code = "HSM_AUTH_FAILED"

    def __init__(self) -> None:
        super().__init__("authenticate", cause="HSM PIN authentication failed")
