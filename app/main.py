from fastapi import Depends, Request, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from jose import jwt, JWTError

from app import app
from app.config import get_settings
from app.models import EmbedReq, EmbedResp, AskReq, TitleEmbedRequest
from app.services import embedding, qa

origins = [
    "http://localhost",
    "http://localhost:3000"
]

# CORS 미들웨어 등록
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,          
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

settings = get_settings()

# ───────────────────────────────── JWT 검증 ──────────────────────────────────
async def verify_jwt(request: Request) -> dict:
    auth = request.headers.get("Authorization")
    if not auth or not auth.startswith("Bearer "):
        raise HTTPException(401, "Missing Bearer token")
    token = auth.split(" ")[1]
    try:
        return jwt.decode(token, settings.secret_key, [settings.algorithm])
    except JWTError as e:
        raise HTTPException(401, f"Invalid token: {e}")

# ───────────────────────────────── Endpoints ─────────────────────────────────
# 제목 임베딩
@app.post("/ai/embeddings/title")
async def embed_title(req: TitleEmbedRequest):
    await embedding.store_title_embedding(str(req.post_id), req.title)
    return {"ok": True}

# 본문 임베딩
@app.post("/ai/embeddings/content", response_model=EmbedResp) #, dependencies=[Depends(verify_jwt)] )
async def embed_route(req: EmbedReq):
    chunks = embedding.chunk_text(req.content)  # 특정 크기(최대 512)로 자름
    embData = await embedding.embed_texts(chunks)   # 임베딩
    await embedding.store_embeddings(req.post_id, chunks, embData)  # 임베딩을 저장
    return EmbedResp(post_id=req.post_id, chunk_count=len(chunks))

# 질문에 대한 응답을 sse로 전달
@app.post("/ai/ask") #, dependencies=[Depends(verify_jwt)])
async def ask_route(req: AskReq):
    return StreamingResponse(
        qa.answer_stream(
            req.question,
            req.user_id,
            req.category_id 
        ),
        media_type="text/event-stream"
    )

# 서버 체크 용
@app.get("/ai/health")
async def health_route():
    return {"status": "ok"}
