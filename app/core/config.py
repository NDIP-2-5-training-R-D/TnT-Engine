from pydantic_settings import BaseSettings
from dotenv import load_dotenv

load_dotenv()


class Settings(BaseSettings):
    openbao_addr: str = "http://localhost:8200"
    openbao_token: str = "root"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
