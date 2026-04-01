"""Structured logging with PII masking and trace context injection."""

from __future__ import annotations

import re

import structlog


# Patterns that look like PII — mask them in logs
_PII_PATTERNS = [
    re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),                              # SSN
    re.compile(r"\b\d{16}\b"),                                           # CC no separators
    re.compile(r"\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b"),              # CC with separators
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"),  # email
]

_MASK = "***REDACTED***"


def _mask_pii(_logger: object, _method: str, event_dict: dict) -> dict:
    """Structlog processor that masks PII patterns in string values."""
    for key, value in event_dict.items():
        if isinstance(value, str):
            for pattern in _PII_PATTERNS:
                value = pattern.sub(_MASK, value)
            event_dict[key] = value
    return event_dict


def _inject_trace_id(_logger: object, _method: str, event_dict: dict) -> dict:
    """Inject the current trace_id from contextvars if present."""
    from tnt_engine.tracing import get_trace_id

    tid = get_trace_id()
    if tid and "trace_id" not in event_dict:
        event_dict["trace_id"] = tid
    return event_dict


def configure_logging() -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            _inject_trace_id,
            _mask_pii,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
