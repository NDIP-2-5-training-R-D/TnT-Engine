"""Role-based access control for tokenization operations.

Determines which callers can perform which operations:
  - TOKENIZER: can tokenize (write) but NOT detokenize (read)
  - DETOKENIZER: can both tokenize and detokenize
  - ADMIN: can tokenize, detokenize, revoke, and delete

The platform enforces this at the SDK/API boundary. Roles are
resolved from the caller's context (e.g., service identity, API key).
"""

from __future__ import annotations

import enum


class Role(str, enum.Enum):
    TOKENIZER = "TOKENIZER"      # write-only: tokenize, mask
    DETOKENIZER = "DETOKENIZER"  # read+write: tokenize, detokenize
    ADMIN = "ADMIN"              # full access: + revoke, delete


class Operation(str, enum.Enum):
    TOKENIZE = "TOKENIZE"
    DETOKENIZE = "DETOKENIZE"
    REVOKE = "REVOKE"
    DELETE = "DELETE"
    MASK = "MASK"
    PROCESS = "PROCESS"


_ROLE_PERMISSIONS: dict[Role, frozenset[Operation]] = {
    Role.TOKENIZER: frozenset({
        Operation.TOKENIZE, Operation.MASK, Operation.PROCESS,
    }),
    Role.DETOKENIZER: frozenset({
        Operation.TOKENIZE, Operation.DETOKENIZE, Operation.MASK, Operation.PROCESS,
    }),
    Role.ADMIN: frozenset({
        Operation.TOKENIZE, Operation.DETOKENIZE,
        Operation.REVOKE, Operation.DELETE,
        Operation.MASK, Operation.PROCESS,
    }),
}


class AccessDeniedError(Exception):
    """Raised when a caller lacks permission for an operation."""

    def __init__(self, role: Role, operation: Operation) -> None:
        self.role = role
        self.operation = operation
        super().__init__(
            f"Role '{role.value}' is not permitted to perform '{operation.value}'"
        )


class AccessControl:
    """Enforces role-based operation permissions."""

    def check(self, role: Role, operation: Operation) -> None:
        """Raise AccessDeniedError if the role lacks permission."""
        if operation not in _ROLE_PERMISSIONS.get(role, frozenset()):
            raise AccessDeniedError(role, operation)

    def is_allowed(self, role: Role, operation: Operation) -> bool:
        return operation in _ROLE_PERMISSIONS.get(role, frozenset())

    def get_permissions(self, role: Role) -> frozenset[Operation]:
        return _ROLE_PERMISSIONS.get(role, frozenset())
