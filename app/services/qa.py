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
    similarity_threshold: float = 0.6
) ->list[dict[str, str | float]]:
    pool = await get_pool()

    # 질문을 임베딩 한 값을 받아 벡터 형식으로 변환
    vec_str = f"[{','.join(map(str, q_embed))}]"

    # 조회시 제목과 본문을 모두 고려하여 가져 옴

    # 카테고리 아이디가 있는 경우 
    if category_id:
        sql = """
        WITH ranked_chunks AS (
            SELECT
              fp.post_id,
              fp.title,
              pc.content,
              ($5 * (1.0 / (1.0 + (pc.embedding <-> $3::vector)))) +
              ($6 * (1.0 / (1.0 + (pte.embedding <-> $3::vector)))) AS similarity_score
            FROM blog_post fp
            JOIN post_chunks pc ON pc.post_id = fp.post_id
            JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
            WHERE fp.user_id = $1 AND fp.category_id = $2
            ORDER BY similarity_score DESC
            LIMIT $4
        )
        SELECT * FROM ranked_chunks;
        """
        # WHERE 조건에서 fp.user_id 와 fp.category_id 사용하도록 수정했습니다.
        # $1: user_id, $2: category_id, $3: vec_str, $4: limit, $5: alpha, $6: beta
        params = (user_id, category_id, vec_str, limit, alpha, beta)
    # 카테고리 아이디가 없는 경우
    else:
        sql = """
        WITH ranked_chunks AS (
            SELECT
              fp.post_id,
              fp.title,
              pc.content,
              ($4 * (1.0 / (1.0 + (pc.embedding <-> $2::vector)))) +
              ($5 * (1.0 / (1.0 + (pte.embedding <-> $2::vector)))) AS similarity_score
            FROM blog_post fp
            JOIN post_chunks pc ON pc.post_id = fp.post_id
            JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
            WHERE fp.user_id = $1
            ORDER BY similarity_score DESC
            LIMIT $3
        )
        SELECT * FROM ranked_chunks;
        """
        # $1: user_id, $2: vec_str, $3: limit, $4: alpha, $5: beta
        params = (user_id, vec_str, limit, alpha, beta)

    rows = await pool.fetch(sql, *params)


    
    # 임계값(similarity_threshold)을 기준으로 필터링
    # 포스트 아이디, 제목, 청크를 하나의 객체로 싸 배열로 반환
    filtered_data = []
    for r in rows:
        if r["similarity_score"] >= similarity_threshold:
            filtered_data.append({
                "post_id":    str(r["post_id"]),
                "post_title": r["title"], # SQL에서 fp.title을 직접 가져옴
                "post_chunk":  r["content"], # SQL에서 pc.content를 직접 가져옴
                "similarity_score": float(r["similarity_score"]) # 유사도 점수도 반환
            })
    return filtered_data



# 질문에 대한 대답을 생성해 스트림으로 전달
async def answer_stream(
    question: str,
    user_id: str,
    category_id: str | None,
    limit: int = 5,
    # 필요하다면 answer_stream 함수에도 similarity_threshold 파라미터를 추가하여
    # 호출 시 동적으로 임계값을 설정할 수 있게 할 수 있습니다.
    # 여기서는 similar_chunks 함수의 기본값(0.6)을 사용합니다.
) -> AsyncIterator[str]:
    
    # 질문 임베딩
    q_embed = (await embed_texts([question]))[0]

    # 제목 + 본문 청크 하이브리드 검색
    # similar_chunks 호출 시 기본 임계값(0.6)이 사용됨
    similar_data = await similar_chunks(
        q_embed,
        user_id,
        category_id,
        limit,
        alpha=0.7,
        beta=0.3,
        # similarity_threshold=0.55 # 다른 임계값을 사용하고 싶다면 여기서 지정
    )
    
    # 1. existInPost Python 변수 선언 및 값 할당
    existInPost = bool(similar_data)
    # 2. existInPost 값을 클라이언트에 별도 이벤트로 전달 (필요 없다면 이 부분 삭제)
    yield f"event: exist_in_post_status\ndata: {json.dumps(existInPost)}\n\n"
    # 3. 원래의 context 이벤트는 그대로 전달, similarity_score포함.
    chunks_payload = json.dumps(similar_data, ensure_ascii=False)
    yield f"event: context\ndata: {chunks_payload}\n\n"


    # LLM에 전달할 context_for_llm 구성
    if not existInPost: # similar_data가 비어있는 경우
        context_for_llm = "NO POST IN USER BLOG(relevance threshold not met)"
    else:
        entries = []
        for item in similar_data:
            title = item["post_title"]
            chunk = item["post_chunk"]
            score = item.get("similarity_score", 0.0) # 점수가 있을 경우 표시 (디버깅/참고용)
            entries.append(
                f"Blog Post Context Title: {title} (Similarity: {score:.2f})\n"
                f"Blog Post Context Text:\n{chunk}"
            )
        # 각 포스트별로 구분해 병합
        context_for_llm = "\n---\n".join(entries)

    # 프롬프트 구성

    prompt_message = f"""
당신은 블로그 내용을 기반으로 방문객의 질문에 답변하는 AI 어시스턴트이자 해당 블로그의 운영자 역할을 수행합니다.
당신은 다음 세 가지 함수 중 하나를 반드시 선택하여 호출해야 합니다: `answer_from_context`, `report_content_not_found`, `address_problematic_query`.

다음은 사용자 질문과 제공된 블로그 본문 컨텍스트입니다.
사용자 질문: "{question}"
블로그 본문 컨텍스트 (관련 내용을 찾지 못했거나, 임계값 미달 시 "NO POST IN USER BLOG..." 로 표시됨):
---
{context_for_llm}
---

이제 다음 규칙에 따라 어떤 함수를 호출할지 결정하고, 해당 함수의 'text' 파라미터에 사용자에게 전달할 최종 답변을 한국어로 작성해주세요.

규칙:
1.  먼저 사용자 질문의 성격을 분석합니다.
    - 만약 질문이 욕설/비난이거나, 블로그 내용과 무관한 일반적인 대화 시도(예: "안녕?", "농담 해줘"), 의미를 알 수 없는 내용이거나, 답변할 수 없는 부적절한 요청이라면, `address_problematic_query` 함수를 호출하세요. 'text' 파라미터에는 "죄송하지만, 저는 블로그 내용과 관련된 질문에 답변을 드리기 위해 여기에 있습니다. 다른 질문이 있으신가요?" 또는 "말씀하신 내용을 이해하기 어렵습니다. 블로그 내용과 관련하여 좀 더 자세히 질문해주시겠어요?" 와 같이 정중하게 응답합니다. 이 경우 "블로그 본문 컨텍스트"는 참고하지 않습니다.

2.  사용자 질문이 블로그 내용에 대한 문의일 가능성이 있다고 판단되면, 제공된 "블로그 본문 컨텍스트"를 확인합니다.
    a.  만약 "블로그 본문 컨텍스트"가 "NO POST IN USER BLOG (relevance threshold not met)" 또는 "NO POST IN USER BLOG" 와 같이 관련 내용을 찾지 못했다는 표시라면:
        - `report_content_not_found` 함수를 호출하세요. 'text' 파라미터에는 "죄송합니다. 문의하신 '{question}'에 대한 내용은 아직 제 블로그에 작성된 글이 없거나, 현재로서는 충분히 관련된 내용을 찾지 못했습니다." 와 같이 답변합니다.
    b.  만약 "블로그 본문 컨텍스트"에 실제 글의 일부(Title, Text)가 제공되었다면, 이 내용을 바탕으로 사용자 질문에 직접적인 답변을 할 수 있는지 판단합니다.
        - 답변을 할 수 있다면, `answer_from_context` 함수를 호출하세요. 'text' 파라미터에는 컨텍스트를 기반으로 생성한 답변을 포함합니다. 답변은 반드시 제공된 컨텍스트 내용만을 근거해야 하며, 간결하고 명확하게 작성합니다.
        - 제공된 컨텍스트가 주제는 유사하나 질문에 대한 직접적인 답변을 포함하고 있지 않거나, 정보가 충분하지 않다면, `report_content_not_found` 함수를 호출하세요. 'text' 파라미터에는 "관련된 글에서 정보를 찾아보았지만, '{question}'에 대한 구체적인 답변은 찾기 어렵습니다. 질문을 조금 다르게 해주시거나 다른 궁금한 점을 알려주시겠어요?" 와 같이 답변합니다.

항상 블로그 운영자로서 친절하고 예의바른 말투를 사용해주세요. 모든 답변은 한국어로 제공되어야 합니다.
"""

    messages = [
        {"role": "user", "content": prompt_message}
    ]
    
    tools = [
        {
            "type": "function",
            "function": {
                "name": "answer_from_context",
                "description": "제공된 블로그 본문에서 답변을 찾아 사용자에게 전달할 때 사용합니다.",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string", "description": "블로그 본문을 기반으로 생성된 답변 내용"}},
                    "required": ["text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "report_content_not_found",
                "description": "질문이 블로그 주제와 관련은 있으나, 본문에서 답변을 찾지 못했거나 관련 글이 없을 때 사용합니다.",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string", "description": "관련 내용이 없음을 알리는 사용자 안내 메시지"}},
                    "required": ["text"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "address_problematic_query",
                "description": "질문이 블로그 주제와 무관하거나, 부적절하거나, 의미를 알 수 없을 때 사용합니다.",
                "parameters": {
                    "type": "object",
                    "properties": {"text": {"type": "string", "description": "부적절한 질문에 대한 정중한 응답 또는 안내 메시지"}},
                    "required": ["text"],
                },
            },
        }
    ]
    

    # 스트리밍으로 응답
    resp = await client.chat.completions.create(
        model=settings.chat_model,
        stream=True,
        messages=messages,
        tools=tools,
        tool_choice="auto",
    )
    current_tool_call_id = None
    current_function_name = None
    current_arguments_str = ""
    # finish_reason에 따라 한 번만 end 이벤트를 보내기 위한 플래그
    end_event_sent = False

    # 2) 본문 스트리밍
    async for chunk in resp:
        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        delta = choice.delta

        if delta.tool_calls:
            for tool_call_chunk in delta.tool_calls:
                if tool_call_chunk.id: # 새 tool_call 시작 시 초기화 (이 시나리오에서는 보통 하나)
                    if current_tool_call_id != tool_call_chunk.id: # ID가 바뀌면 새 호출 시작으로 간주
                        # 이전 호출에 대한 마무리 (만약 있었다면, 하지만 보통은 finish_reason으로 처리)
                        if current_function_name and current_arguments_str:
                             # 이 지점에 도달하는 것은 비정상적일 수 있으므로 로깅 또는 예외처리 고려
                            pass # 보통 finish_reason으로 처리됨

                        current_tool_call_id = tool_call_chunk.id
                        current_arguments_str = "" # 새 호출이므로 arguments 초기화
                        current_function_name = None


                if tool_call_chunk.function:
                    if tool_call_chunk.function.name:
                        current_function_name = tool_call_chunk.function.name
                    if tool_call_chunk.function.arguments:
                        current_arguments_str += tool_call_chunk.function.arguments
        
        if delta.content and not delta.tool_calls: # LLM이 함수 호출 대신 일반 텍스트 응답을 하는 경우 (이 프롬프트에서는 지양됨)
            text = delta.content
            # 함수 호출을 강제하므로 이 경우는 드물지만, 대비 차원에서 로깅 또는 기본 처리 가능
            # 예: yield f"event: raw_text_response\ndata: {json.dumps({'text': text})}\n\n"

        # 스트림의 끝에서 (또는 tool_calls가 완료될 때) 누적된 arguments를 처리
        if choice.finish_reason and choice.finish_reason == "tool_calls":
            if current_function_name and current_arguments_str:
                # 전체 arguments가 수신되었으므로, 이를 payload로 사용
                yield "event: answer\n"
                # current_arguments_str는 JSON 객체 문자열의 부분 또는 전체일 수 있음.
                # 클라이언트가 파싱할 수 있도록 그대로 전달.
                yield f"data: '{current_arguments_str}'\n\n"
                
                # 처리 후 초기화 (다음 청크에서 새 tool_calls가 올 수도 있지만, 보통 한 번의 요청에는 하나의 로직적 호출)
                current_tool_call_id = None
                current_function_name = None
                current_arguments_str = ""

        if choice.finish_reason and not end_event_sent:
            # 모든 종류의 finish_reason (stop, length, tool_calls, content_filter)에 대해 루프 종료 후 end 이벤트 발생
            # 단, tool_calls로 인해 이미 위에서 answer를 보냈을 수 있음
            yield "event: end\n"
            yield "data: [DONE]\n\n"
            end_event_sent = True # end 이벤트 한 번만 보내도록 플래그 설정
            break # 루프 종료

    # 만약 루프가 정상적으로 (break 없이) 종료되었지만 end_event가 보내지지 않은 경우 (예: 스트림이 비어있는 경우)
    if not end_event_sent:
        yield "event: end\n"
        yield "data: [DONE]\n\n"
