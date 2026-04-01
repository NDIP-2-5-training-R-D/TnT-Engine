"""PKCS#11 session pool manager for HSM integration.

Manages a pool of authenticated PKCS#11 sessions to avoid the overhead
of opening/closing sessions per operation. Sessions are lazily created
and validated before use.

Supports SoftHSM2 (dev/test) and hardware HSMs (Thales Luna, nCipher)
that expose a PKCS#11 interface.

Security invariants:
  - PIN is NEVER logged, even at DEBUG level
  - Sessions are closed on shutdown — no key material leakage
  - Failed PIN auth raises immediately, never retries (lockout risk)
"""

from __future__ import annotations

import asyncio
import queue
import threading
from typing import Any

import PyKCS11

from tnt_engine.errors import (
    HSMAuthenticationError,
    HSMError,
    HSMKeyNotFoundError,
    HSMSessionError,
)
from tnt_engine.logging import get_logger

logger = get_logger(__name__)


class PKCS11SessionPool:
    """Thread-safe pool of authenticated PKCS#11 sessions.

    Usage:
        pool = PKCS11SessionPool(lib_path, slot=0, pin="...", pool_size=5)
        pool.initialize()

        session = pool.acquire()
        try:
            # use session for crypto ops
        finally:
            pool.release(session)

        pool.close()
    """

    def __init__(
        self,
        lib_path: str,
        slot: int,
        pin: str,
        pool_size: int = 5,
    ) -> None:
        self._lib_path = lib_path
        self._slot = slot
        self._pin = pin
        self._pool_size = pool_size
        self._pkcs11 = PyKCS11.PyKCS11Lib()
        self._pool: queue.Queue[PyKCS11.Session] = queue.Queue(maxsize=pool_size)
        self._all_sessions: list[PyKCS11.Session] = []
        self._lock = threading.Lock()
        self._initialized = False

    def initialize(self) -> None:
        """Load PKCS#11 library and pre-create session pool."""
        try:
            self._pkcs11.load(self._lib_path)
        except PyKCS11.PyKCS11Error as exc:
            raise HSMSessionError(
                "load_library", cause=f"Failed to load PKCS#11 library: {self._lib_path}"
            ) from exc

        slots = self._pkcs11.getSlotList(tokenPresent=True)
        if self._slot not in slots:
            raise HSMSessionError(
                "slot_lookup",
                cause=f"Slot {self._slot} not found. Available: {slots}",
            )

        for _ in range(self._pool_size):
            session = self._open_session()
            self._pool.put(session)
            self._all_sessions.append(session)

        self._initialized = True
        logger.info(
            "pkcs11_pool_initialized",
            slot=self._slot,
            pool_size=self._pool_size,
        )

    def _open_session(self) -> PyKCS11.Session:
        """Open and authenticate a single PKCS#11 session."""
        try:
            session = self._pkcs11.openSession(
                self._slot,
                PyKCS11.CKF_SERIAL_SESSION | PyKCS11.CKF_RW_SESSION,
            )
        except PyKCS11.PyKCS11Error as exc:
            raise HSMSessionError("open_session", cause=str(exc)) from exc

        try:
            session.login(self._pin)
        except PyKCS11.PyKCS11Error as exc:
            error_str = str(exc)
            if "CKR_PIN_INCORRECT" in error_str or "CKR_PIN_LOCKED" in error_str:
                raise HSMAuthenticationError() from exc
            # CKR_USER_ALREADY_LOGGED_IN is acceptable in shared-session HSMs
            if "CKR_USER_ALREADY_LOGGED_IN" not in error_str:
                raise HSMSessionError("login", cause=error_str) from exc

        return session

    def acquire(self, timeout: float = 10.0) -> PyKCS11.Session:
        """Acquire a session from the pool. Blocks up to timeout seconds."""
        if not self._initialized:
            raise HSMSessionError("acquire", cause="Session pool not initialized")
        try:
            session = self._pool.get(timeout=timeout)
        except queue.Empty:
            raise HSMSessionError(
                "acquire", cause=f"No session available within {timeout}s"
            )
        # Validate session is still alive
        try:
            session.getSessionInfo()
        except PyKCS11.PyKCS11Error:
            logger.warning("pkcs11_session_stale_replacing")
            with self._lock:
                self._all_sessions.remove(session)
                session = self._open_session()
                self._all_sessions.append(session)
        return session

    def release(self, session: PyKCS11.Session) -> None:
        """Return a session to the pool."""
        try:
            self._pool.put_nowait(session)
        except queue.Full:
            # Pool is full — close the extra session
            try:
                session.logout()
                session.closeSession()
            except PyKCS11.PyKCS11Error:
                pass

    def close(self) -> None:
        """Close all sessions and release resources."""
        with self._lock:
            for session in self._all_sessions:
                try:
                    session.logout()
                except PyKCS11.PyKCS11Error:
                    pass
                try:
                    session.closeSession()
                except PyKCS11.PyKCS11Error:
                    pass
            self._all_sessions.clear()
            # Drain queue
            while not self._pool.empty():
                try:
                    self._pool.get_nowait()
                except queue.Empty:
                    break
            self._initialized = False
        logger.info("pkcs11_pool_closed")

    def find_key(
        self,
        session: PyKCS11.Session,
        label: str,
        key_class: int = PyKCS11.CKO_SECRET_KEY,
    ) -> Any:
        """Find a key object by label in the given session.

        Returns the key handle.
        Raises HSMKeyNotFoundError if no key with that label exists.
        """
        template = [
            (PyKCS11.CKA_CLASS, key_class),
            (PyKCS11.CKA_LABEL, label),
        ]
        objects = session.findObjects(template)
        if not objects:
            raise HSMKeyNotFoundError(label)
        return objects[0]

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def available_count(self) -> int:
        return self._pool.qsize()
