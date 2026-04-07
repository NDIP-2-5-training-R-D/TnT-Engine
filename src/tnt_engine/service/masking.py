"""Field masking strategies.

Masking replaces part of a value with a fixed character while preserving
enough structure for display purposes. Unlike tokenization, masking is
one-way and irreversible — the original value cannot be recovered.

Strategies are selected by field type:
  - email:  j***@example.com
  - phone:  ***-***-5678
  - ssn:    ***-**-6789
  - card:   ****-****-****-1234
  - name:   J*** D***
  - default: first 2 + *** + last 2
"""

from __future__ import annotations

import re

_MASK_CHAR = "*"


def mask_value(value: str, field_type: str) -> str:
    """Apply masking strategy based on field type. Returns masked string."""
    strategy = _STRATEGIES.get(field_type, _mask_default)
    return strategy(value)


def _mask_email(value: str) -> str:
    parts = value.split("@", 1)
    if len(parts) != 2:
        return _mask_default(value)
    local, domain = parts
    if not local:
        return f"{_MASK_CHAR * 3}@{domain}"
    return f"{local[0]}{_MASK_CHAR * 3}@{domain}"


def _mask_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 4:
        return _MASK_CHAR * len(value)
    last4 = digits[-4:]
    return f"{_MASK_CHAR * 3}-{_MASK_CHAR * 3}-{last4}"


def _mask_ssn(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 4:
        return _MASK_CHAR * len(value)
    last4 = digits[-4:]
    return f"{_MASK_CHAR * 3}-{_MASK_CHAR * 2}-{last4}"


def _mask_card(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) < 4:
        return _MASK_CHAR * len(value)
    last4 = digits[-4:]
    return f"{_MASK_CHAR * 4}-{_MASK_CHAR * 4}-{_MASK_CHAR * 4}-{last4}"


def _mask_name(value: str) -> str:
    words = value.split()
    masked_words = []
    for word in words:
        if len(word) <= 1:
            masked_words.append(word)
        else:
            masked_words.append(f"{word[0]}{_MASK_CHAR * 3}")
    return " ".join(masked_words)


def _mask_default(value: str) -> str:
    if len(value) <= 4:
        return _MASK_CHAR * len(value)
    return f"{value[:2]}{_MASK_CHAR * 3}{value[-2:]}"


_STRATEGIES: dict[str, callable] = {
    "email": _mask_email,
    "phone": _mask_phone,
    "ssn": _mask_ssn,
    "card": _mask_card,
    "credit_card": _mask_card,
    "name": _mask_name,
    "first_name": _mask_name,
    "last_name": _mask_name,
}


def apply_mask_template(value: str, template: str) -> str:
    """Apply a user-supplied masking template to value.

    Template syntax:
        '#' — reveal the character at this position (pass-through)
        '*' — mask the character at this position (replace with '*')
        any other character — literal separator inserted into the output
                              (does NOT consume a character from value)

    Examples:
        apply_mask_template("1234567890123456", "****-****-****-####")
        → "****-****-****-3456"

        apply_mask_template("user@example.com", "###@****")
        → "use@****"

    If the template is longer than value (after accounting for separators),
    remaining '#' positions emit '#' and remaining '*' positions emit '*'.
    """
    out: list[str] = []
    vi = 0
    for tc in template:
        if tc == "#":
            out.append(value[vi] if vi < len(value) else "#")
            vi += 1
        elif tc == "*":
            if vi < len(value):
                vi += 1
            out.append("*")
        else:
            out.append(tc)  # literal separator — does not advance value index
    return "".join(out)
