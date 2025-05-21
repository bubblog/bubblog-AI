from pydantic import BaseModel
from typing import Optional

class EmbedReq(BaseModel):
    post_id: int
    content: str

class EmbedResp(BaseModel):
    post_id: int
    chunk_count: int
    success: bool = True

class AskReq(BaseModel):
    question: str
    user_id: str
    category_id: Optional[str] = None

class ChatLog(BaseModel):
    user_id: str | None
    question: str
    answer: str

class TitleEmbedRequest(BaseModel):
    post_id: int
    title: str
    