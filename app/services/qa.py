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
        WITH filtered_posts AS (
          SELECT id    AS post_id,
                 title
            FROM blog_post
           WHERE user_id     = $1
             AND category_id = $2
        )
        SELECT
          fp.post_id,
          fp.title      AS post_title,
          pc.content    AS post_chunk, -- 수정: 쉼표(,) 추가
          ( 
            $5 * (1.0 / (1.0 + (pc.embedding <-> $3::vector)))
            + $6 * (1.0 / (1.0 + (pte.embedding <-> $3::vector)))
          ) AS similarity_score -- 컬럼으로 선택
        FROM filtered_posts fp
        JOIN post_chunks pc
          ON pc.post_id = fp.post_id
        JOIN post_title_embeddings pte
          ON pte.post_id = fp.post_id
        ORDER BY
          similarity_score DESC
        LIMIT $4;
        """
        # $1: user_id, $2: category_id, $3: vec_str, $4: limit, $5: alpha, $6: beta
        params = (user_id, category_id, vec_str, limit, alpha, beta)
    # 카테고리 아이디가 없는 경우
    else:
        sql = """
        WITH filtered_posts AS (
          SELECT id    AS post_id,
                 title
            FROM blog_post
           WHERE user_id = $1
        )
        SELECT
          fp.post_id,
          fp.title      AS post_title,
          pc.content    AS post_chunk, -- 수정: 쉼표(,) 추가
          ( 
            $4 * (1.0 / (1.0 + (pc.embedding <-> $2::vector)))
            + $5 * (1.0 / (1.0 + (pte.embedding <-> $2::vector)))
          ) AS similarity_score -- 컬럼으로 선택
        FROM filtered_posts fp
        JOIN post_chunks pc
          ON pc.post_id = fp.post_id
        JOIN post_title_embeddings pte
          ON pte.post_id = fp.post_id
        ORDER BY
          similarity_score DESC
        LIMIT $3;
        """
        params = (user_id, vec_str, limit, alpha, beta)

    rows = await pool.fetch(sql, *params)
    
    # 임계값(similarity_threshold)을 기준으로 필터링
    # 포스트 아이디, 제목, 청크를 하나의 객체로 싸 배열로 반환
    filtered_data = []
    for r in rows:
        if r["similarity_score"] >= similarity_threshold:
            filtered_data.append({
                "post_id":    str(r["post_id"]),
                "post_title": r["post_title"], # 수정: SQL alias와 일치 (r["title"] -> r["post_title"])
                "post_chunk":  r["post_chunk"], # 수정: SQL alias와 일치 (r["content"] -> r["post_chunk"])
                "similarity_score": float(r["similarity_score"]) # 유사도 점수도 반환
            })
    return filtered_data


# 질문에 대한 대답을 생성해 스트림으로 전달
async def answer_stream(
    question: str,
    user_id: str,
    category_id: str | None,
    limit: int = 5,
    speech_tone: str = "default"
) -> AsyncIterator[str]:
    
    # 질문 임베딩
    q_embed = (await embed_texts([question]))[0]

    # 제목 + 본문 청크 하이브리드 검색
    # similar_chunks 호출 시 기본 임계값(0.6)이 사용됨 (사용자 코드에서는 0.2으로 지정)

    # 말투 옵션
    
    speech_tone_for_llm_0 = "상대방을 존중하는 높임말, 하심시오체를 사용해"
    speech_tone_for_llm_1 = "상대가 나보다 아랫사람이거나 나보다 하등한 사람인거처럼 반말로해줘"
    speech_tone_for_llm_2 = "전문성있게 간단하고 명료하게 설명해"
    speech_tone_for_llm_3 = "경상도, 부산, 대구 사투리와 같은 말로 반말해"
    
    try:
        similar_data = await similar_chunks(
            q_embed,
            user_id,
            category_id,
            limit,
            alpha=0.7,
            beta=0.3,
            similarity_threshold=0.2,# 다른 임계값을 사용하고 싶다면 여기서 지정 (사용자 지정값 유지)
            speech_tone = speech_tone_for_llm#0,1,2,3
        )
    except:
        similar_data = await similar_chunks(
            q_embed,
            user_id,
            category_id,
            limit,
            alpha=0.7,
            beta=0.3,
            similarity_threshold=0.2 # 다른 임계값을 사용하고 싶다면 여기서 지정 (사용자 지정값 유지)
        )
    
    pool = await get_pool()

    sql = """
        SELECT c.name
        FROM category c
        WHERE c.user_id = $1;
    """
    params = (user_id, )

    rows = await pool.fetch(sql, *params)

    category_names = ", ".join([row["name"] for row in rows])

    # 1. existInPost Python 변수 선언 및 값 할당
    existInPost = bool(similar_data)
    # 2. existInPost 값을 클라이언트에 별도 이벤트로 전달 (필요 없다면 이 부분 삭제)
    yield f"event: exist_in_post_status\ndata: {json.dumps(existInPost)}\n\n"
    # 3. 원래의 context 이벤트는 그대로 전달, similarity_score포함.
    chunks_payload = json.dumps(
      [{"post_id": item["post_id"], "post_title": item["post_title"]} for item in similar_data],
      ensure_ascii=False
    )
    yield f"event: context\ndata: {chunks_payload}\n\n"

    # LLM에 전달할 context_for_llm 구성
    if not existInPost: # similar_data가 비어있는 경우
        context_for_llm = "NO POST IN USER BLOG(relevance threshold not met)"
    else:
        entries = []
        for item in similar_data:
            title = item["post_title"]
            chunk = item["post_chunk"]
            score = item.get("similarity_score", 0.0) # 점수가 있을 경우 표시 (디버깅/참고용) (사용자 선택 유지)
            entries.append(
                f"Blog Post Context Title: {title} (Similarity: {score:.2f})\n"
                f"Blog Post Context Text:\n{chunk}"
            )
        # 각 포스트별로 구분해 병합
        context_for_llm = "\n---\n".join(entries)

    # 프롬프트 구성
    prompt_message = f"""
당신은 블로그 내용을 기반으로 블로그 방문객의 질문에 답변하는 AI 어시스턴트이자 해당 블로그의 운영자 역할을 수행합니다.
사용자는 다음과 같은 카테고리의 글을 작성하는 블로거입니다.
"{category_names}"

다음은 사용자 질문과 제공된 블로그 본문 컨텍스트와 답변의 말투입니다.

사용자 질문: "{question}"
사용자 말투: "{speech_tone}"

블로그 본문 컨텍스트 :
---
{context_for_llm}
---

만약 "{speech_tone}"가 default 라면 "사용자 말투"는 {context_for_llm}의 말투를 사용하세요.

이제 다음 규칙에 따라 어떤 함수를 호출할지 결정하여 사용자에게 전달할 최종 답변을 한국어로 작성해주세요.
답변을 생성할 때는 위에 제시된 "사용자 말투"를 반드시 참고하여 그와 가장 유사한 말투로 작성해야 합니다.

규칙: 
1.  사용자 질문의 성격을 분석합니다.
    - 만약 질문이 욕설/비난/블로그 내용과 무관한 일반적인 대화 시도/의미를 알 수 없는 내용/답변할 수 없는 부적절한 요청이라면 `address_problematic_query` 함수를 호출하세요. 'text' 파라미터에는 "죄송하지만, 저는 블로그 내용과 관련된 질문에 답변을 드리기 위해 여기에 있습니다. 다른 질문이 있으신가요?" 또는 "말씀하신 내용을 이해하기 어렵습니다. 블로그 내용과 관련하여 좀 더 자세히 질문해주시겠어요?" 와 같이 정중하게 응답합니다. 이 경우 "블로그 본문 컨텍스트"는 참고하지 않습니다.

2.  사용자 질문이 블로그 내용에 대한 문의일 가능성이 있다고 판단되면, 제공된 "블로그 본문 컨텍스트"를 확인합니다.
    다음 a,b,c의 경우들중 알맞는 경우를 선택하여 답변을 할때 반드시 "사용자 말투"와 가장 유사한 말투로 답변을 바꾸어 답변해야 합니다.
    a.  만약 "블로그 본문 컨텍스트"가 "NO POST IN USER BLOG (relevance threshold not met)" 또는 "NO POST IN USER BLOG" 와 같이 관련 내용을 찾지 못했다는 표시라면::
        - `report_content_not_found` 함수를 호출하세요. 'text' 파라미터에는 "죄송합니다. 문의하신 '{question}'에 대한 내용은 아직 제 블로그에 작성된 글이 없거나, 현재로서는 충분히 관련된 내용을 찾지 못했습니다." 와 같이 답변합니다.
    b.  만약 "블로그 본문 컨텍스트"가 제공되었다면, 이 내용을 바탕으로 사용자 질문에 직접적인 답변을 할 수 있는지 판단합니다.
        - 제공된 컨텍스트로 답변을 할 수 있다면(단, 절대 지어내지 말고 블로그의 글을 기반으로 대답하세요!), `answer_from_context` 함수를 호출하세요. 'text' 파라미터에는 컨텍스트를 기반으로 생성한 답변을 포함합니다. 간결하고 명확하게 작성합니다. 모든 작성이 끝난 뒤, 마지막으로 "이에 대해서 더 궁금하신것이 있을까요?" 와 같이 더 자세한 질문을 유도하는 답변을 작성합니다.
        - 또는 제공된 컨텍스트가 정보로 최대한 대답을 하고 만약 정보가 충분하지 않다면, `report_content_not_found` 함수를 호출하세요. 'text' 파라미터에는 "관련된 글에서 정보를 찾아보았지만, 해당 질문에 대한 구체적인 답변은 찾기 어렵습니다. 질문을 조금 자세하게 해주시거나 다른 궁금한 점을 알려주시겠어요?" 와 같이 답변합니다.
    c. 블로그 글이 아닌 블로그 전체에 대한 질문일 경우 사용자 정보를 기반으로 대답하세요

최종적인 말투는 주어진 "사용자 말투"를 따라야 합니다. 모든 답변은 한국어로 제공되어야 합니다.
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
    # finish_reason에 따라 한 번만 end 이벤트를 보내기 위한 플래그
    end_event_sent = False # 사용자 코드 위치 유지
    # 스트리밍으로 응답
    resp = await client.chat.completions.create(
        model=settings.chat_model,
        stream=True,
        messages=messages,
        tools=tools,
        tool_choice="auto",
    )
    current_tool_call_id = None # 사용자 코드 위치 및 변수 선언 유지
    current_function_name = None # 사용자 코드 위치 및 변수 선언 유지
    current_arguments_str = "" # 사용자 코드 위치 및 변수 선언 유지
    

    # 2) 본문 스트리밍
    # 비동기적으로 OpenAI API로부터 오는 응답 청크(chunk)들을 하나씩 반복 처리
    async for chunk in resp:
        # 현재 청크(chunk)에 유효한 선택지(choices)가 없으면, 
        # 이 청크는 처리할 내용이 없으므로 다음 청크로 이동
        # 네트워크 오류 등으로 빈 청크가 올 경우를 대비한 방어 코드
        if not chunk.choices:
            continue
        
        # API 응답의 choices 리스트중 첫 번째 선택
        choice = chunk.choices[0]
        # 'delta' 필드에 내용 담김
        delta = choice.delta

        # 청크의 delta.tool_calls 는 LLM이 이전에 정의한 'tools'(함수) 중 하나 또는 여러 개를 호출함
        if delta.tool_calls:
            # 하나의 delta 메시지 안에 여러 tool_call에 대한 조각(chunk)이 올 수 있음 (병렬 함수 호출의 경우)
            # 각각의 tool_call_chunk에 대해 반복 처리
            # (현재 프롬프트 설계상 보통 하나의 함수만 호출되도록 유도)
            for tool_call_chunk in delta.tool_calls:
                ## 만약 tool_call_chunk에 id가 있다면
                # 현재 처리 중인 tool_call의 고유 ID를 저장하여 여러 tool_call을 구분하거나 상태를 추적하는 데 사용
                
                # if tool_call_chunk.id: # 사용자 주석 및 코드 유지
                #     current_tool_call_id = tool_call_chunk.id # 사용자 주석 및 코드 유지
                
                ## 만약 tool_call_chunk에 호출된 함수의 이름(name) 정보가 있다면
                # 어떤 함수가 호출되었는지 이름을 저장하여 추적하는 데 사용
                # if tool_call_chunk.function and tool_call_chunk.function.name: # 사용자 주석 및 코드 유지
                #     current_function_name = tool_call_chunk.function.name # 사용자 주석 및 코드 유지
                
                ## 만약 tool_call_chunk에 해당 함수 호출의 인자(arguments) 정보가 있다면,
                # (arguments는 JSON 형식의 문자열이며, 스트리밍 시 여러 조각으로 나뉘어 올 수 있습니다.)
                if tool_call_chunk.function and tool_call_chunk.function.arguments:
                    args_payload_chunk = tool_call_chunk.function.arguments
                    # 클라이언트에게 'answer' 타입의 SSE(Server-Sent Event)를 보낼 준비
                    yield "event: answer\n"
                    yield f"data: '{args_payload_chunk}'\n\n"
                    #전송완료
        
        # 만약 현재 청크의 delta에 일반 텍스트 내용(content)이 있고, 동시에 tool_calls는 없는 경우입니다.
        # (현재 사용 중인 프롬프트는 LLM이 tool_calls를 사용하도록 강하게 유도하고 있으므로,
        # 이 경로로 응답이 오는 경우는 거의 없거나, LLM이 프롬프트 지시를 따르지 않은 예외적인 상황일 수 있습니다.)
        if delta.content and not delta.tool_calls: 
            # LLM이 (드물게) 함수 호출 대신 일반 텍스트로 응답하는 경우
            # text = delta.content # 일반 텍스트 내용으로 가져옴
            # # 일반 텍스트도 JSON 형식으로 변경 후 전송
            # temp_args = json.dumps({"text": text}, ensure_ascii=False) 
            # yield "event: answer\n" # 혹은 다른 이벤트 타입 (예: "text_response")
            # yield f"data: '{temp_args}'\n\n"
            pass # 사용자 코드 주석 및 pass 유지

        # 만약 현재 choice에 스트림의 종료를 나타내는 이유(finish_reason) 정보가 있고,
        # 아직 'end' 이벤트가 클라이언트에게 전송되지 않았다면,
        if choice.finish_reason and not end_event_sent:
            # finish_reason의 값은 'stop'(정상적으로 모든 토큰 생성 완료), 'length'(최대 토큰 길이 도달로 중단), 
            # 'tool_calls'(LLM이 도구/함수 호출을 결정하고 해당 정보를 모두 보냈을 때), 
            # 'content_filter'(OpenAI의 안전 필터에 의해 중단)
            # 'tool_calls'가 finish_reason인 경우, 위 `if delta.tool_calls:` 블록에서 이미 arguments 조각들이 스트리밍되었을 것
            # 어떤 이유로든 현재 응답 스트림이 종료되면, 클라이언트에게 'end' 이벤트를 전송하여 스트림 종료를 알림
            yield "event: end\n"
            yield "data: [DONE]\n\n" # 스트림 종료를 나타내는 표준 메시지
            # 'end' 이벤트는 한 번만 전송해야 하므로, 전송되었음을 플래그로 표시
            end_event_sent = True 
            # 스트림 처리를 완전히 중단
            break 

    #여기서 'end' 이벤트를 확실히 전송합니다. (사용자 주석 유지)
    if not end_event_sent:
        yield "event: end\n"
        yield "data: [DONE]\n\n"
