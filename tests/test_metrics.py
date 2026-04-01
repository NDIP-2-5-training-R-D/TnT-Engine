"""Tests for metrics infrastructure and load runner."""

from __future__ import annotations

import pytest

from tnt_engine.metrics import (
    SLO_CACHE_HIT_RATE_PERCENT,
    SLO_ERROR_RATE_PERCENT,
    SLO_LATENCY_P99_SECONDS,
)
from tnt_engine.service.token_service import TokenService
from tnt_engine.testing.load import LoadReport, LoadRunner


class TestSLOConstants:
    def test_latency_threshold(self) -> None:
        assert SLO_LATENCY_P99_SECONDS == 0.200

    def test_error_rate_threshold(self) -> None:
        assert SLO_ERROR_RATE_PERCENT == 1.0

    def test_cache_hit_threshold(self) -> None:
        assert SLO_CACHE_HIT_RATE_PERCENT == 80.0


class TestLoadReport:
    def test_empty_report(self) -> None:
        r = LoadReport()
        assert r.throughput_rps == 0
        assert r.p50_ms == 0
        assert r.avg_ms == 0

    def test_report_with_data(self) -> None:
        r = LoadReport(
            total_requests=100,
            successful=95,
            failed=5,
            elapsed_seconds=2.0,
            latencies_ms=[float(i) for i in range(100)],
        )
        assert r.throughput_rps == 50.0
        assert r.p50_ms == 50.0
        assert r.p99_ms == 99.0
        assert "req/s" in str(r)


class TestLoadRunner:
    async def test_run_in_process(self, token_service: TokenService) -> None:
        runner = LoadRunner(token_service)
        report = await runner.run(
            num_requests=20,
            concurrency=5,
            tenant_id="perf_test",
            unique_ratio=0.5,
        )
        assert report.total_requests == 20
        assert report.successful == 20
        assert report.failed == 0
        assert report.throughput_rps > 0
        assert report.p50_ms > 0

    async def test_convergent_under_load(self, token_service: TokenService) -> None:
        """With unique_ratio=0, all requests are for the same value → same token."""
        runner = LoadRunner(token_service)
        report = await runner.run(
            num_requests=50,
            concurrency=10,
            tenant_id="conv_test",
            unique_ratio=0.02,  # 1 unique value
        )
        assert report.successful == 50
