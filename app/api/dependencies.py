from fastapi import Header, HTTPException, status, Depends

from app.config import settings
from app.core.policy_loader import get_policy_loader, PolicyLoader
from app.core.orchestrator import Orchestrator


async def verify_vault_token(x_vault_token: str = Header(..., alias="X-Vault-Token")):
    """Validate that X-Vault-Token header is present and matches configured token."""
    if x_vault_token != settings.vault_token:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid or missing X-Vault-Token",
        )
    return x_vault_token


def get_orchestrator(policy_loader: PolicyLoader = Depends(get_policy_loader)) -> Orchestrator:
    return Orchestrator(policy_loader)
