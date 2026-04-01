"""Chaos testing hooks for validating system resilience.

Wraps infrastructure components with configurable fault injection:
  - Latency injection (simulate slow DB/Redis/crypto)
  - Error injection (simulate failures at configurable rates)
  - Total failure (simulate complete outage)

Usage:
    from tnt_engine.testing.chaos import ChaosProxy, FaultConfig

    # Wrap the real crypto backend with chaos
    chaotic_crypto = ChaosProxy(
        real_crypto_backend,
        FaultConfig(error_rate=0.1, latency_ms=200),
    )

    # Use in TokenService — 10% of calls will fail, all delayed 200ms
    svc = TokenService(hmac=chaotic_crypto, encryption=chaotic_crypto, ...)

Design:
  - ChaosProxy wraps ANY async callable object via __getattr__
  - FaultConfig is immutable and can be swapped at runtime
  - Thread-safe for asyncio
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from functools import wraps
from typing import Any

from tnt_engine.logging import get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class FaultConfig:
    """Configuration for fault injection.

    Attributes:
        error_rate: Probability of injecting an error (0.0–1.0).
        latency_ms: Additional latency in milliseconds (0 = none).
        total_failure: If True, ALL calls fail immediately.
        error_message: Message for injected errors.
    """
    error_rate: float = 0.0
    latency_ms: int = 0
    total_failure: bool = False
    error_message: str = "Chaos fault injected"


class ChaosError(Exception):
    """Error injected by chaos testing."""


class ChaosProxy:
    """Wraps any object with fault injection on async method calls.

    Non-async attributes are passed through unchanged.
    """

    def __init__(self, target: Any, config: FaultConfig | None = None) -> None:
        self._target = target
        self._config = config or FaultConfig()

    @property
    def config(self) -> FaultConfig:
        return self._config

    @config.setter
    def config(self, value: FaultConfig) -> None:
        self._config = value

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if not callable(attr):
            return attr
        if not asyncio.iscoroutinefunction(attr):
            return attr

        @wraps(attr)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            cfg = self._config

            # Total failure — immediate reject
            if cfg.total_failure:
                logger.warning("chaos_total_failure", method=name)
                raise ChaosError(f"Total failure: {cfg.error_message}")

            # Latency injection
            if cfg.latency_ms > 0:
                delay = cfg.latency_ms / 1000.0
                await asyncio.sleep(delay)

            # Random error injection
            if cfg.error_rate > 0 and random.random() < cfg.error_rate:
                logger.warning("chaos_error_injected", method=name, rate=cfg.error_rate)
                raise ChaosError(cfg.error_message)

            return await attr(*args, **kwargs)

        return wrapper
