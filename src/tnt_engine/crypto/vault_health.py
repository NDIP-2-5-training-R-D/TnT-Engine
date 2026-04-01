"""OpenBao/Vault health checker for application health endpoints.

Probes the OpenBao `/sys/health` endpoint to determine if the
crypto service is operational. Returns structured status info
for inclusion in the application's `/api/v1/health` response.

States:
  - healthy: OpenBao is initialized, unsealed, and active
  - sealed: OpenBao is sealed — crypto operations will fail
  - uninitialized: OpenBao has not been initialized yet
  - standby: Node is a standby (HA) — reads may work, writes forwarded
  - unreachable: Cannot connect to OpenBao
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import httpx

from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class VaultStatus(str, Enum):
    HEALTHY = "healthy"
    SEALED = "sealed"
    UNINITIALIZED = "uninitialized"
    STANDBY = "standby"
    UNREACHABLE = "unreachable"


@dataclass(frozen=True)
class VaultHealthResult:
    """Result of a Vault health check."""
    status: VaultStatus
    initialized: bool = False
    sealed: bool = True
    version: str = ""
    cluster_name: str = ""

    @property
    def is_operational(self) -> bool:
        return self.status in (VaultStatus.HEALTHY, VaultStatus.STANDBY)


class VaultHealthChecker:
    """Probes OpenBao health for inclusion in app health checks.

    Usage:
        checker = VaultHealthChecker("http://openbao:8200")
        result = await checker.check()
        if not result.is_operational:
            alert(...)
    """

    def __init__(
        self, base_url: str, timeout: float = 3.0,
        settings: object | None = None,
    ) -> None:
        # Strip /v1 suffix if present (crypto_base_url includes it, but /sys/health needs root)
        clean_base = base_url.rstrip("/")
        if clean_base.endswith("/v1"):
            clean_base = clean_base[:-3]
        self._url = clean_base + "/v1/sys/health"
        if settings is not None:
            from tnt_engine.crypto._http import build_httpx_client
            self._client = build_httpx_client(settings, timeout=timeout)
        else:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout))

    async def check(self) -> VaultHealthResult:
        """Probe OpenBao health. Non-throwing — always returns a result."""
        try:
            # OpenBao /sys/health returns:
            #   200 = initialized, unsealed, active
            #   429 = unsealed, standby
            #   472 = data recovery mode replication secondary
            #   501 = not initialized
            #   503 = sealed
            resp = await self._client.get(self._url)
            body = resp.json()

            initialized = body.get("initialized", False)
            sealed = body.get("sealed", True)
            version = body.get("version", "")
            cluster = body.get("cluster_name", "")

            if resp.status_code == 200:
                status = VaultStatus.HEALTHY
            elif resp.status_code == 429:
                status = VaultStatus.STANDBY
            elif resp.status_code == 501:
                status = VaultStatus.UNINITIALIZED
            elif resp.status_code == 503:
                status = VaultStatus.SEALED
            else:
                status = VaultStatus.SEALED if sealed else VaultStatus.HEALTHY

            result = VaultHealthResult(
                status=status,
                initialized=initialized,
                sealed=sealed,
                version=version,
                cluster_name=cluster,
            )
            self._update_metrics(result)
            return result

        except httpx.HTTPError as exc:
            logger.warning("vault_health_unreachable", error=str(exc))
            result = VaultHealthResult(status=VaultStatus.UNREACHABLE)
            self._update_metrics(result)
            return result

        except Exception as exc:
            logger.warning("vault_health_check_error", error=str(exc))
            result = VaultHealthResult(status=VaultStatus.UNREACHABLE)
            self._update_metrics(result)
            return result

    @staticmethod
    def _update_metrics(result: VaultHealthResult) -> None:
        from tnt_engine.metrics import VAULT_HEALTH_SEALED
        VAULT_HEALTH_SEALED.set(1 if result.sealed else 0)

    async def close(self) -> None:
        await self._client.aclose()
