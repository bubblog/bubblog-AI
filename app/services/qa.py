from __future__ import annotations
from typing import AsyncIterator
import json
from openai import AsyncOpenAI

from app.config import get_settings
from app.db import get_pool
from app.services.embedding import embed_texts

settings = get_settings()
client = AsyncOpenAI(api_key=settings.openai_api_key)

# 가까운 청크 즉 블로그 본문 청크를 find
async def similar_chunks(
    q_embed: list[float],
    user_id: str,
    category_id: str | None = None,
    limit: int = 5,
    alpha: float = 0.7,
    beta: float = 0.3,
) -> list[dict[str, str]]:
    pool = await get_pool()

    # 질문을 임베딩 한 값을 받아 벡터 형식으로 변환
    vec_str = f"[{','.join(map(str, q_embed))}]"

    # 조회시 제목과 본문을 모두 고려하여 가져 옴

    # 카테고리 아이디가 있는 경우 
    if category_id:
        sql = """
        WITH filtered_posts AS (
          SELECT id   AS post_id,
                 title
            FROM blog_post
           WHERE user_id    = $1
             AND category_id = $2
        )
        SELECT
          fp.post_id,
          fp.title      AS post_title,
          pc.content    AS post_chunk
        FROM filtered_posts fp
        JOIN post_chunks pc
          ON pc.post_id = fp.post_id
        JOIN post_title_embeddings pte
          ON pte.post_id = fp.post_id
        ORDER BY
          (
            $5 * (1.0 / (1.0 + (pc.embedding <-> $3::vector)))
            + $6 * (1.0 / (1.0 + (pte.embedding <-> $3::vector)))
          ) DESC
        LIMIT $4;
        """
        params = (user_id, category_id, vec_str, limit, alpha, beta)
    # 카테고리 아이디가 없는 경우
    else:
        sql = """
        WITH filtered_posts AS (
          SELECT id   AS post_id,
                 title
            FROM blog_post
           WHERE user_id = $1
        )
        SELECT
          fp.post_id,
          fp.title      AS post_title,
          pc.content    AS post_chunk
        FROM filtered_posts fp
        JOIN post_chunks pc
          ON pc.post_id = fp.post_id
        JOIN post_title_embeddings pte
          ON pte.post_id = fp.post_id
        ORDER BY
          (
            $4 * (1.0 / (1.0 + (pc.embedding <-> $2::vector)))
            + $5 * (1.0 / (1.0 + (pte.embedding <-> $2::vector)))
          ) DESC
        LIMIT $3;
        """
        params = (user_id, vec_str, limit, alpha, beta)

    rows = await pool.fetch(sql, *params)

    # 포스트 아이디, 제목, 청크를 하나의 객체로 싸 배열로 반환
    return [
        {
            "post_id":    str(r["post_id"]),
            "post_title": r["post_title"],
            "post_chunk":  r["post_chunk"],
        }
        for r in rows
    ]

# 질문에 대한 대답을 생성해 스트림으로 전달
async def answer_stream(
    question: str,
    user_id: str,
    category_id: str | None,
    limit: int = 5,
) -> AsyncIterator[str]:
    
    # 질문 임베딩
    q_embed = (await embed_texts([question]))[0]

    # 제목 + 본문 청크 하이브리드 검색
    similar_data = await similar_chunks(
        q_embed,
        user_id,
        category_id,
        limit,
        alpha=0.7,
        beta=0.3,
    )

    # 먼저 질문과 가장 가깝게 검색된 글을 응답
    import json
    chunks_payload = json.dumps(similar_data, ensure_ascii=False)
    yield f"event: context\ndata: {chunks_payload}\n\n"


    # context 조립
    if not similar_data:
        context = "NO POST IN USER BLOG"
    else:
        entries = []
        for item in similar_data:
            title = item["post_title"]
            chunk = item["post_chunk"]
            entries.append(
                f"Blog Post Context Title: {title}\n"
                f"Blog Post Context Text:\n{chunk}"
            )
        # 각 포스트별로 구분해 병합
        context = "\n---\n".join(entries)

    # 프롬프트 구성
    prompt_message = f"""
        You are a helpful AI assistant answering questions based on the provided blog post excerpts.
        Use ONLY the information from the provided "Blog Post Context" to answer the user's question.
        If the context doesn't contain the answer, state that the information is not available in the provided text.
        Be concise and directly answer the question.
        언제나 한국어로 대답해.

        User Question: {question}

        {context}

        Based on the blog post context, please answer the user's question.
    """

    messages = [
        {
            "role": "system",
            "content": "You are a helpful AI assistant answering questions based on provided blog post excerpts."
        },
        {
            "role": "user",
            "content": prompt_message
        }
    ]

    functions = [{
        "name": "answer",
        "description": "Return answer referencing excerpts.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }]

    # 스트리밍으로 응답
    resp = await client.chat.completions.create(
        model=settings.chat_model,
        stream=True,
        messages=messages,
        functions=functions,
        function_call={"name": "answer"},
    )

    async for chunk in resp:
        choice = chunk.choices[0]
        if choice.finish_reason is None:
            args = choice.delta.function_call.arguments if choice.delta.function_call else ""
            if args:
                yield f"data: {args}"
        else:
            break

    yield "event: end\ndata: [DONE]"