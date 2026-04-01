import logging
from typing import Optional

logger = logging.getLogger(__name__)


class DbAdapter:
    """
    Mock DB/Redis adapter — will be replaced by real Postgres/Redis calls (Thienlinh).
    All methods mirror the interface that the real adapter must implement.
    TODO: replace mock implementations with asyncpg / redis calls.
    """

    def __init__(self):
        # TODO: replace with real connection pool
        self._store: dict[str, str] = {}
        self._roles: dict[str, dict] = {}
        self._templates: dict[str, dict] = {}
        self._transformations: dict[str, dict] = {}

    async def save_token(self, token: str, original: str) -> None:
        """Persist token → original mapping."""
        # TODO: INSERT INTO token_store (token, original) VALUES (...)
        self._store[token] = original
        logger.debug("MOCK save_token token=%s", token)

    async def lookup_token(self, token: str) -> Optional[str]:
        """Retrieve original value for a token."""
        # TODO: SELECT original FROM token_store WHERE token = ...
        result = self._store.get(token)
        logger.debug("MOCK lookup_token token=%s found=%s", token, result is not None)
        return result

    # ── Role CRUD ─────────────────────────────────────────────────────────────

    async def save_role(self, name: str, data: dict) -> None:
        self._roles[name] = data

    async def get_role(self, name: str) -> Optional[dict]:
        return self._roles.get(name)

    async def list_roles(self) -> list[str]:
        return list(self._roles.keys())

    async def delete_role(self, name: str) -> bool:
        if name in self._roles:
            del self._roles[name]
            return True
        return False

    # ── Template CRUD ─────────────────────────────────────────────────────────

    async def save_template(self, name: str, data: dict) -> None:
        self._templates[name] = data

    async def get_template(self, name: str) -> Optional[dict]:
        return self._templates.get(name)

    async def list_templates(self) -> list[str]:
        return list(self._templates.keys())

    async def delete_template(self, name: str) -> bool:
        if name in self._templates:
            del self._templates[name]
            return True
        return False

    # ── Transformation CRUD ───────────────────────────────────────────────────

    async def save_transformation(self, name: str, data: dict) -> None:
        self._transformations[name] = data

    async def get_transformation(self, name: str) -> Optional[dict]:
        return self._transformations.get(name)

    async def list_transformations(self) -> list[str]:
        return list(self._transformations.keys())

    async def delete_transformation(self, name: str) -> bool:
        if name in self._transformations:
            del self._transformations[name]
            return True
        return False


_db_adapter = DbAdapter()


def get_db_adapter() -> DbAdapter:
    return _db_adapter
