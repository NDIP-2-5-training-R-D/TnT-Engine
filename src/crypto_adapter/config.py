from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    OPENBAO_ADDR: str = "http://openbao:8200"
    OPENBAO_ROLE_ID: str = ""
    OPENBAO_SECRET_ID: str = ""
    OPENBAO_TRANSIT_KEY: str = "tt-engine-key"
    OPENBAO_TOKEN_CACHE_TTL: int = 3600
    SERVICE_PORT: int = 8300
    SERVICE_HOST: str = "0.0.0.0"
    LOG_LEVEL: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
