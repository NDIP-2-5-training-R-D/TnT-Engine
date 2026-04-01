from datetime import datetime, timedelta, timezone

from pydantic import BaseModel, Field


class OpenBaoToken(BaseModel):
    client_token: str
    lease_duration: int  # seconds
    renewable: bool
    acquired_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def expires_at(self) -> datetime:
        return self.acquired_at + timedelta(seconds=self.lease_duration)

    @property
    def is_expired(self) -> bool:
        remaining = (self.expires_at - datetime.now(timezone.utc)).total_seconds()
        return remaining < 60

    @property
    def seconds_until_renew(self) -> float:
        """Seconds to sleep before renewing (renew 120s before expiry)."""
        renew_at = self.expires_at - timedelta(seconds=120)
        delta = (renew_at - datetime.now(timezone.utc)).total_seconds()
        return max(delta, 0)
