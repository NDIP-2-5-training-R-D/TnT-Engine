"""Async PostgreSQL connection pool management.

Supports:
  - Primary pool (read/write)
  - Optional read replica pool (read-only queries)
  - Statement timeout enforcement
  - Pool size metrics
"""

from __future__ import annotations

import asyncpg

from tnt_engine.config import Settings
from tnt_engine.metrics import DB_POOL_SIZE


class Database:
    """Manages asyncpg connection pool lifecycle with optional read replica."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._pool: asyncpg.Pool | None = None
        self._read_pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        timeout_ms = self._settings.db_statement_timeout_ms

        async def _init_conn(conn: asyncpg.Connection) -> None:
            await conn.execute(f"SET statement_timeout = '{timeout_ms}'")

        self._pool = await asyncpg.create_pool(
            host=self._settings.db_host,
            port=self._settings.db_port,
            database=self._settings.db_name,
            user=self._settings.db_user,
            password=self._settings.db_password,
            min_size=self._settings.db_pool_min,
            max_size=self._settings.db_pool_max,
            command_timeout=timeout_ms / 1000,
            init=_init_conn,
        )
        DB_POOL_SIZE.labels(pool="primary").set(self._settings.db_pool_max)

        # Read replica (optional)
        if self._settings.db_read_host:
            self._read_pool = await asyncpg.create_pool(
                host=self._settings.db_read_host,
                port=self._settings.db_read_port,
                database=self._settings.db_name,
                user=self._settings.db_user,
                password=self._settings.db_password,
                min_size=self._settings.db_pool_min,
                max_size=self._settings.db_pool_max,
                command_timeout=timeout_ms / 1000,
                init=_init_conn,
            )
            DB_POOL_SIZE.labels(pool="read_replica").set(self._settings.db_pool_max)

    async def close(self) -> None:
        if self._pool:
            await self._pool.close()
        if self._read_pool:
            await self._read_pool.close()

    @property
    def pool(self) -> asyncpg.Pool:
        """Primary read/write pool."""
        if self._pool is None:
            raise RuntimeError("Database not connected. Call connect() first.")
        return self._pool

    @property
    def read_pool(self) -> asyncpg.Pool:
        """Read replica pool. Falls back to primary if no replica configured."""
        if self._read_pool is not None:
            return self._read_pool
        return self.pool
