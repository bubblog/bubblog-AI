from typing import Sequence, List
import openai
from starlette.concurrency import run_in_threadpool
import re
import tiktoken
from typing import List

from app.config import get_settings
from app.db import get_pool

settings = get_settings()
openai.api_key = settings.openai_api_key

## 글을 문장단위로 나누어(최대 512) 분할
def chunk_text(
    content: str,
    max_tokens: int = 512,
    overlap_tokens: int = 50,
    model: str = "text-embedding-3-small"
) -> List[str]:
    # 1) 문장별로 분리
    sentences = re.split(r'(?<=[\.\?\!])\s+', content)

    # 2) tiktoken 인코더 초기화
    enc = tiktoken.encoding_for_model(model)

    chunks: List[str] = []
    current_chunk = ""
    current_tokens = []

    for sentence in sentences:
        sent_tokens = enc.encode(sentence)
        # 이 문장을 추가해도 max_tokens 이내면 추가
        if len(current_tokens) + len(sent_tokens) <= max_tokens:
            current_chunk = (current_chunk + " " + sentence).strip()
            current_tokens += sent_tokens
        else:
            # 3) 청크 확정 & 저장
            if current_chunk:
                chunks.append(current_chunk)
            # 다음 청크 초기화 (오버랩 포함)
            overlap = current_tokens[-overlap_tokens:] if overlap_tokens < len(current_tokens) else current_tokens
            current_tokens = overlap + sent_tokens
            # 토큰 → 문자열 복원
            current_chunk = enc.decode(current_tokens)

    # 마지막 남은 청크 저장
    if current_chunk:
        chunks.append(current_chunk)

    return chunks

# 분할 할 청크를 청크 순 대로 저장
async def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    def sync_embed():
        return openai.embeddings.create(
            model=settings.embed_model,
            input=list(texts)
        )
    # 스레드 풀을 이용해 처리
    resp = await run_in_threadpool(sync_embed)
    return [item.embedding for item in resp.data]

# 임베딩 값을 디비에 저장
# 만일 기존 값 즉, 수정의 경우 이전 임베딩값을 전부 삭제 후 저장
async def store_embeddings(
    post_id: str,
    chunks: list[str],
    embs: list[list[float]]
):
    pool = await get_pool()

    # 기존 임베딩값 전부 삭제
    await pool.execute(
        "DELETE FROM post_chunks WHERE post_id = $1",
        int(post_id)
    )
    
    # 벡터형식(pgvector에서 호환되는 형식)으로 변경
    vector_strs = [f"[{','.join(map(str, vec))}]" for vec in embs]
    
    # 청크 단위로 포스트 아이디,청크 인덱스,글, 글 임베딩 벡터 디비에 저장
    q = """
    INSERT INTO post_chunks(post_id, chunk_index, content, embedding)
    SELECT x.post_id, x.chunk_index, x.content, x.embedding
    FROM UNNEST(
      $1::bigint[],
      $2::int[],
      $3::text[],
      $4::vector[]
    ) AS x(post_id, chunk_index, content, embedding)
    """
    await pool.execute(
        q,
        [int(post_id)] * len(chunks),
        list(range(len(chunks))),
        chunks,
        vector_strs
    )

async def store_title_embedding(post_id: str, title: str):
    pool = await get_pool()
    # 제목 임베딩 생성
    title_vec = (await embed_texts([title]))[0]
    # pg vector 형식에 맞게 변환
    title_vec_str = f"[{','.join(map(str, title_vec))}]"
    # 저장 (없으면 INSERT, 있으면 UPDATE)
    q = """
    INSERT INTO post_title_embeddings(post_id, embedding)
    VALUES ($1, $2::vector)
    ON CONFLICT (post_id) DO
      UPDATE SET embedding = EXCLUDED.embedding
    """
    # 쿼리 실행
    await pool.execute(q, int(post_id), title_vec_str)