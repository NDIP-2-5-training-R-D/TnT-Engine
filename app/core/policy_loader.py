import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MOCK_POLICY_PATH = Path(__file__).parent.parent.parent / "policies" / "mock_policies.json"


class PolicyLoader:
    """
    Loads pipeline and transformation configs.
    Currently mocked from a JSON file — swap get_pipeline / get_transformation
    implementations when DB adapter (Thienlinh) is ready.
    """

    def __init__(self, policy_path: Path = _MOCK_POLICY_PATH):
        self._path = policy_path
        self._data: Optional[dict] = None

    def _load(self) -> dict:
        if self._data is None:
            # TODO: replace file read with DB call (db_adapter.get_policies())
            with open(self._path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
        return self._data

    async def get_pipeline(self, role: str) -> Optional[dict]:
        """Return pipeline config for a role, or None if not found."""
        data = self._load()
        pipeline = data.get("pipelines", {}).get(role)
        if pipeline is None:
            logger.warning("No pipeline found for role '%s'", role)
        return pipeline

    async def get_transformation(self, name: str) -> Optional[dict]:
        """Return transformation config by name, or None if not found."""
        data = self._load()
        transformation = data.get("transformations", {}).get(name)
        if transformation is None:
            logger.warning("No transformation found for name '%s'", name)
        return transformation

    async def list_pipelines(self) -> list[str]:
        data = self._load()
        return list(data.get("pipelines", {}).keys())

    async def list_transformations(self) -> list[str]:
        data = self._load()
        return list(data.get("transformations", {}).keys())


# Singleton — swap to DI if needed
_policy_loader = PolicyLoader()


def get_policy_loader() -> PolicyLoader:
    return _policy_loader
