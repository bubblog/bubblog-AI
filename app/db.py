import asyncpg
from typing import Optional
from app.config import get_settings

_pool: Optional[asyncpg.Pool] = None

async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        settings = get_settings()
        _pool = await asyncpg.create_pool(settings.database_url, min_size=1, max_size=5)
    return _pool