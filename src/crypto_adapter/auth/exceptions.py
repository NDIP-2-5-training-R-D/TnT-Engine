class OpenBaoAuthError(Exception):
    """AppRole login or token renewal failures."""


class OpenBaoUnavailableError(Exception):
    """Connection errors and timeouts."""


class OpenBaoCryptoError(Exception):
    """Crypto operation failures."""


class CircuitBreakerOpenError(OpenBaoUnavailableError):
    """Raised when the circuit breaker is in OPEN state."""
