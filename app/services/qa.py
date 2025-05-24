from __future__ import annotations
from typing import AsyncIterator
import json
from openai import AsyncOpenAI

from app.config import get_settings
from app.db import get_pool
from app.services.embedding import embed_texts

settings = get_settings()
client = AsyncOpenAI(api_key=settings.openai_api_key)

# 가까운 청크 즉 블로그 본문 청크를 finds
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
    #박의찬 Start
    # 1. existInPost Python 변수 선언 및 값 할당
    existInPost = bool(similar_data)
    # 2. existInPost 값을 클라이언트에 별도 이벤트로 전달 (필요 없다면 이 부분 삭제)
    yield f"event: exist_in_post_status\ndata: {json.dumps(existInPost)}\n\n"
    # 3. 원래의 context 이벤트는 그대로 전달
    chunks_payload = json.dumps(similar_data, ensure_ascii=False)
    yield f"event: context\ndata: {chunks_payload}\n\n"

    



    # LLM에 전달할 context_for_llm 구성
    if not existInPost: # similar_data가 비어있는 경우
        context_for_llm = "NO POST IN USER BLOG"
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
        당신은 이 블로그의 운영자입니다. 당신의 역할은 방문객의 질문에 대해서 당신이 작성한 블로그 게시글을 참고하여 답변하는 것입니다.
        당신의 말투는 블로그 운영자 본인인 것처럼 자연스러워야 합니다. 언제나 한국어로 대답해주세요.

        답변을 생성할 때 다음 지침을 따라주세요:
        1.  제공된 "블로그 게시물 내용"만을 참고하여 답변해야 합니다. 외부 지식을 사용하지 마세요. "블로그 게시물 내용"이 "NO POST IN USER BLOG"이라면, 제가 아직 해당 주제에 대해 글을 작성하지 않았다고 답변해주세요.
        2.  질문에 대한 답변이 "블로그 게시물 내용"에 명확히 있다면, 해당 내용을 바탕으로 제가 직접 말하는 것처럼 직접적이고 간결하게 답변해주세요.
        3.  질문에 대한 답변이 "블로그 게시물 내용"에 없다면, "죄송하지만, 그 내용에 대해서는 아직 글을 작성하지 않았어요." 또는 "제가 쓴 글 중에는 관련된 내용이 없네요." 와 같이 블로그 운영자 본인이 직접 말하는 것처럼 부드럽게 답변해주세요. "제공된 텍스트에서는 정보를 찾을 수 없습니다." 또는 "정보가 없습니다." 와 같은 딱딱한 표현은 사용하지 마세요.
        4.  방문객은 당신을 블로그 운영자라고 생각하고 질문하며, 당신은 블로그 운영자의 입장에서 답변해야 합니다.

        방문객 질문: {question}

        블로그 게시물 내용:
        {context}

        위의 "블로그 게시물 내용"을 바탕으로, 블로그 운영자의 입장에서 방문객의 질문에 답변해주세요.
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

    # 2) 본문 스트리밍
    async for chunk in resp:
        choice = chunk.choices[0]

        # 텍스트 델타가 있으면
        if hasattr(choice.delta, "content") and choice.delta.content:
            text = choice.delta.content
            # 모델이 생성한 조각 그대로 보내되, 한 번에 델타 전체를
            yield "event: answer\n"
            yield f"data: '{text}'\n\n"

        # 함수 호출 arguments 델타가 있으면
        if choice.delta.function_call and choice.delta.function_call.arguments:
            args = choice.delta.function_call.arguments
            yield "event: answer\n"
            yield f"data: '{args}'\n\n"

        # 끝났으면
        if choice.finish_reason:
            yield "event: end\n"
            yield "data: [DONE]\n\n"
            break

    yield "event: end\ndata: [DONE]"
