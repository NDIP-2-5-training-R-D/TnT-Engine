"""Lightweight tracing context for request correlation.

Propagates a trace_id through the async call chain using contextvars.
This integrates with structlog for automatic trace_id injection into logs,
and with the audit_log table for post-hoc debugging.
"""

from __future__ import annotations

import secrets
from contextvars import ContextVar

_trace_id_var: ContextVar[str | None] = ContextVar("trace_id", default=None)


def get_trace_id() -> str | None:
    return _trace_id_var.get()


def set_trace_id(trace_id: str) -> None:
    _trace_id_var.set(trace_id)


def generate_trace_id() -> str:
    """Generate a 16-byte hex trace ID."""
    return secrets.token_hex(16)


def ensure_trace_id() -> str:
    """Return the current trace_id, or generate and set a new one."""
    tid = _trace_id_var.get()
    if tid is None:
        tid = generate_trace_id()
        _trace_id_var.set(tid)
    return tid
