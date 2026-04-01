"""Performance testing hooks for the T&T Engine.

Provides utilities to simulate load and measure throughput/latency
against a running TokenService instance (not over HTTP — in-process).

Usage:
    from tnt_engine.testing.load import LoadRunner

    runner = LoadRunner(token_service)
    report = await runner.run(
        num_requests=5000,
        concurrency=100,
        tenant_id="load_test",
    )
    print(report)
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field

from tnt_engine.models.domain import TokenizeRequest
from tnt_engine.service.token_service import TokenService


@dataclass
class LoadReport:
    total_requests: int = 0
    successful: int = 0
    failed: int = 0
    elapsed_seconds: float = 0.0
    latencies_ms: list[float] = field(default_factory=list)

    @property
    def throughput_rps(self) -> float:
        return self.total_requests / self.elapsed_seconds if self.elapsed_seconds > 0 else 0

    @property
    def p50_ms(self) -> float:
        return self._percentile(50)

    @property
    def p95_ms(self) -> float:
        return self._percentile(95)

    @property
    def p99_ms(self) -> float:
        return self._percentile(99)

    @property
    def avg_ms(self) -> float:
        return sum(self.latencies_ms) / len(self.latencies_ms) if self.latencies_ms else 0

    def _percentile(self, p: float) -> float:
        if not self.latencies_ms:
            return 0.0
        sorted_lats = sorted(self.latencies_ms)
        idx = int(len(sorted_lats) * p / 100)
        return sorted_lats[min(idx, len(sorted_lats) - 1)]

    def __str__(self) -> str:
        return (
            f"LoadReport(\n"
            f"  total={self.total_requests}, ok={self.successful}, fail={self.failed}\n"
            f"  elapsed={self.elapsed_seconds:.2f}s\n"
            f"  throughput={self.throughput_rps:.0f} req/s\n"
            f"  avg={self.avg_ms:.1f}ms  p50={self.p50_ms:.1f}ms  "
            f"p95={self.p95_ms:.1f}ms  p99={self.p99_ms:.1f}ms\n"
            f")"
        )


class LoadRunner:
    """In-process load tester for TokenService."""

    def __init__(self, service: TokenService) -> None:
        self._svc = service

    async def run(
        self,
        num_requests: int = 1000,
        concurrency: int = 50,
        tenant_id: str = "load_test",
        unique_ratio: float = 0.5,
    ) -> LoadReport:
        """
        Run a load test.

        Args:
            num_requests: Total number of tokenize requests.
            concurrency: Max concurrent requests.
            tenant_id: Tenant to use.
            unique_ratio: Fraction of requests with unique values (rest are duplicates).
        """
        # Generate values — some unique, some repeated
        unique_count = max(1, int(num_requests * unique_ratio))
        unique_values = [secrets.token_hex(16) for _ in range(unique_count)]
        values = [unique_values[i % unique_count] for i in range(num_requests)]

        semaphore = asyncio.Semaphore(concurrency)
        report = LoadReport(total_requests=num_requests)

        async def _run_one(value: str) -> None:
            async with semaphore:
                t0 = time.monotonic()
                try:
                    await self._svc.tokenize(
                        TokenizeRequest(value=value, field="perf_test", tenant_id=tenant_id)
                    )
                    report.successful += 1
                except Exception:
                    report.failed += 1
                report.latencies_ms.append((time.monotonic() - t0) * 1000)

        t_start = time.monotonic()
        await asyncio.gather(*[_run_one(v) for v in values])
        report.elapsed_seconds = time.monotonic() - t_start

        return report
