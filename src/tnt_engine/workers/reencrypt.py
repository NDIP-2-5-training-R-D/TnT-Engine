"""Background worker: re-encrypt tokens after key rotation.

When a new transit key version is deployed, this worker:
1. Fetches tokens encrypted with old key versions
2. Decrypts with the old key
3. Re-encrypts with the current key
4. Updates the token_store row

Uses SKIP LOCKED for safe multi-replica operation.
"""

from __future__ import annotations

import asyncio

from prometheus_client import Counter

from tnt_engine.config import Settings
from tnt_engine.crypto.interface import EncryptionService
from tnt_engine.db.repository import TokenRepository
from tnt_engine.logging import get_logger

logger = get_logger(__name__)

REENCRYPT_COUNT = Counter("tnt_reencrypt_total", "Tokens re-encrypted")
REENCRYPT_ERRORS = Counter("tnt_reencrypt_errors_total", "Re-encryption errors")


class ReencryptWorker:
    def __init__(
        self,
        repo: TokenRepository,
        encryption: EncryptionService,
        settings: Settings,
        target_key_version: int,
    ) -> None:
        self._repo = repo
        self._encryption = encryption
        self._batch_size = settings.worker_reencrypt_batch_size
        self._target_version = target_key_version
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self, interval: float = 10.0) -> None:
        self._running = True
        self._task = asyncio.create_task(self._loop(interval))
        logger.info(
            "reencrypt_worker_started",
            target_version=self._target_version,
        )

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("reencrypt_worker_stopped")

    async def _loop(self, interval: float) -> None:
        while self._running:
            try:
                count = await self.run_batch()
                if count == 0:
                    logger.info("reencrypt_complete")
                    self._running = False
                    return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("reencrypt_worker_error")
            await asyncio.sleep(interval)

    async def run_batch(self) -> int:
        """Re-encrypt a single batch. Returns number of tokens processed."""
        records = await self._repo.get_tokens_for_reencrypt(
            self._target_version, self._batch_size
        )
        if not records:
            return 0

        count = 0
        for rec in records:
            try:
                # Decrypt with old key
                plaintext = await self._encryption.decrypt(
                    rec.value_encrypted, rec.key_version
                )
                # Re-encrypt with current key
                new_ciphertext, new_version = await self._encryption.encrypt(plaintext)
                # Update DB
                await self._repo.update_encrypted_value(
                    rec.token, new_ciphertext, new_version
                )
                REENCRYPT_COUNT.inc()
                count += 1
            except Exception:
                REENCRYPT_ERRORS.inc()
                logger.exception(
                    "reencrypt_token_failed",
                    token_prefix=rec.token[:12],
                )
                continue

        logger.info("reencrypt_batch_complete", count=count, total=len(records))
        return count
