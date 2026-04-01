import unicodedata


def canonicalize(value: str, lowercase: bool = False) -> str:
    """Strip whitespace, NFC-normalize, optionally lowercase."""
    value = value.strip()
    value = unicodedata.normalize("NFC", value)
    if lowercase:
        value = value.lower()
    return value


def canonicalize_dict(data: dict, lowercase: bool = False) -> str:
    """Sort dict keys, canonicalize each value, return key=value&... string."""
    sorted_items = sorted(data.items())
    parts = [f"{k}={canonicalize(str(v), lowercase)}" for k, v in sorted_items]
    return "&".join(parts)
