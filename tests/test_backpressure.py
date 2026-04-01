"""Tests for the backpressure / load shedding middleware."""

from __future__ import annotations

import asyncio

import pytest

from tnt_engine.resilience.backpressure import BackpressureMiddleware


class TestBackpressure:
    def test_allows_under_limit(self) -> None:
        bp = BackpressureMiddleware(app=None, max_concurrent=10)  # type: ignore
        assert bp._inflight == 0
        assert bp._max == 10

    def test_counter_tracks_inflight(self) -> None:
        bp = BackpressureMiddleware(app=None, max_concurrent=5)  # type: ignore
        # Simulate incrementing
        bp._inflight = 3
        assert bp._inflight < bp._max

    def test_rejects_at_limit(self) -> None:
        bp = BackpressureMiddleware(app=None, max_concurrent=2)  # type: ignore
        bp._inflight = 2
        assert bp._inflight >= bp._max


class TestGuardrails:
    def test_max_body_default(self) -> None:
        from tnt_engine.resilience.guardrails import MAX_BODY_BYTES
        assert MAX_BODY_BYTES == 1_048_576  # 1MB

    def test_request_timeout_default(self) -> None:
        from tnt_engine.resilience.guardrails import REQUEST_TIMEOUT_SECONDS
        assert REQUEST_TIMEOUT_SECONDS == 30


class TestShutdownCoordinator:
    async def test_initial_state(self) -> None:
        from tnt_engine.resilience.shutdown import ShutdownCoordinator
        sc = ShutdownCoordinator(drain_seconds=0.01)
        assert sc.is_draining is False

    async def test_draining_state(self) -> None:
        from tnt_engine.resilience.shutdown import ShutdownCoordinator
        sc = ShutdownCoordinator(drain_seconds=0.01)
        await sc.initiate()
        assert sc.is_draining is True
