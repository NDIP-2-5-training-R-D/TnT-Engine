"""Redis L2 cache with latency instrumentation and configurable timeouts.

Write-through caching:
  - On tokenize: write cache after DB write succeeds
  - On cache miss: fall back to DB, then backfill cache
  - On Redis failure: log + continue (cache is an optimization, not a requirement)
"""

from __future__ import annotations

import time

import redis.asyncio as redis

from tnt_engine.config import Settings
from tnt_engine.logging import get_logger
from tnt_engine.metrics import REDIS_ERRORS, REDIS_LATENCY

logger = get_logger(__name__)

_PREFIX = "tnt:tok:"


class TokenCache:
    """Redis-backed L2 cache with latency tracking and timeout enforcement."""

    def __init__(self, settings: Settings) -> None:
        self._ttl = settings.redis_token_ttl_seconds
        self._pool = redis.ConnectionPool.from_url(
            settings.redis_url,
            max_connections=settings.redis_max_connections,
            decode_responses=True,
            socket_timeout=settings.redis_socket_timeout_seconds,
            socket_connect_timeout=settings.redis_connect_timeout_seconds,
        )
        self._redis = redis.Redis(connection_pool=self._pool)

    async def get(self, key: str) -> str | None:
        t0 = time.monotonic()
        try:
            val = await self._redis.get(f"{_PREFIX}{key}")
            REDIS_LATENCY.labels(operation="get").observe(time.monotonic() - t0)
            return val
        except redis.RedisError:
            REDIS_ERRORS.labels(operation="get").inc()
            logger.warning("redis_get_failed", key_prefix=key[:16])
            return None

    async def set(self, key: str, token: str) -> None:
        t0 = time.monotonic()
        try:
            await self._redis.set(f"{_PREFIX}{key}", token, ex=self._ttl)
            REDIS_LATENCY.labels(operation="set").observe(time.monotonic() - t0)
        except redis.RedisError:
            REDIS_ERRORS.labels(operation="set").inc()
            logger.warning("redis_set_failed", key_prefix=key[:16])

    async def get_multi(self, keys: list[str]) -> dict[str, str | None]:
        if not keys:
            return {}
        prefixed = [f"{_PREFIX}{k}" for k in keys]
        t0 = time.monotonic()
        try:
            values = await self._redis.mget(prefixed)
            REDIS_LATENCY.labels(operation="mget").observe(time.monotonic() - t0)
            return dict(zip(keys, values))
        except redis.RedisError:
            REDIS_ERRORS.labels(operation="mget").inc()
            logger.warning("redis_mget_failed")
            return {k: None for k in keys}

    async def set_multi(self, mapping: dict[str, str]) -> None:
        if not mapping:
            return
        t0 = time.monotonic()
        try:
            pipe = self._redis.pipeline(transaction=False)
            for key, token in mapping.items():
                pipe.set(f"{_PREFIX}{key}", token, ex=self._ttl)
            await pipe.execute()
            REDIS_LATENCY.labels(operation="mset").observe(time.monotonic() - t0)
        except redis.RedisError:
            REDIS_ERRORS.labels(operation="mset").inc()
            logger.warning("redis_mset_failed")

    async def delete(self, key: str) -> None:
        try:
            await self._redis.delete(f"{_PREFIX}{key}")
        except redis.RedisError:
            pass

    async def close(self) -> None:
        await self._redis.aclose()
        await self._pool.aclose()
