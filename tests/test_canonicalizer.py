import unicodedata
import pytest
from app.core.canonicalizer import canonicalize, canonicalize_dict


def test_strip_whitespace():
    assert canonicalize("  hello  ") == "hello"


def test_nfc_normalize():
    # NFD form of 'é' (e + combining accent)
    nfd = unicodedata.normalize("NFD", "é")
    assert canonicalize(nfd) == "é"


def test_lowercase_flag():
    assert canonicalize("Hello World", lowercase=True) == "hello world"
    assert canonicalize("Hello World", lowercase=False) == "Hello World"


def test_dict_sorted_keys():
    result = canonicalize_dict({"z": "last", "a": "first"})
    assert result == "a=first&z=last"


def test_dict_strips_values():
    result = canonicalize_dict({"key": "  value  "})
    assert result == "key=value"


def test_dict_empty():
    assert canonicalize_dict({}) == ""


def test_idempotent():
    value = "  Héllo  "
    once = canonicalize(value)
    twice = canonicalize(once)
    assert once == twice
