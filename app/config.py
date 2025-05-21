import os
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
import logging

class Settings(BaseSettings):
    openai_api_key: str 
    database_url: str
    secret_key: str = "CHANGE_ME"
    token_audience: str = "bubblog"
    algorithm: str = "HS256"
    embed_model: str = "text-embedding-3-small"
    chat_model: str = "gpt-4o"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

@lru_cache
def get_settings() -> Settings:
    s = Settings()
    logging.info(f"Loaded DATABASE_URL = {s.database_url!r}")
    print(f"Loaded DATABASE_URL = {s.database_url!r}")
    return s