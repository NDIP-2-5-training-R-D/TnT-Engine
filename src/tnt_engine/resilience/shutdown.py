"""Graceful shutdown coordination.

Ensures that when the process receives SIGTERM (k8s pod termination):
  1. New requests are rejected (readiness probe fails)
  2. In-flight requests are given time to complete
  3. Background workers are stopped
  4. DB/Redis connections are closed

The k8s terminationGracePeriodSeconds (30s) defines the hard deadline.
This module coordinates the soft shutdown within that window.

Usage:
    shutdown = ShutdownCoordinator()
    # In middleware: if shutdown.is_draining: return 503
    # On SIGTERM: shutdown.initiate()
"""

from __future__ import annotations

import asyncio

from prometheus_client import Gauge

from tnt_engine.logging import get_logger

logger = get_logger(__name__)

DRAINING = Gauge("tnt_shutdown_draining", "Whether the service is draining connections")


class ShutdownCoordinator:
    """Coordinates graceful shutdown with connection draining."""

    def __init__(self, drain_seconds: float = 5.0) -> None:
        self._draining = False
        self._drain_seconds = drain_seconds

    @property
    def is_draining(self) -> bool:
        return self._draining

    async def initiate(self) -> None:
        """Begin graceful shutdown. Called from lifespan on exit."""
        logger.info("shutdown_initiated", drain_seconds=self._drain_seconds)
        self._draining = True
        DRAINING.set(1)

        # Wait for in-flight requests to complete
        # The backpressure middleware will reject new requests while draining
        await asyncio.sleep(self._drain_seconds)

        logger.info("shutdown_drain_complete")
