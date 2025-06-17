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
        WITH category_ids AS (
            SELECT DISTINCT cc.descendant_id
            FROM category_closure cc
            WHERE cc.ancestor_id = $2
        ),
        filtered_posts AS (
            SELECT
                bp.id    AS post_id,
                bp.title AS post_title
            FROM blog_post bp
            WHERE bp.user_id     = $1
                AND bp.category_id IN (SELECT descendant_id FROM category_ids)
        )
        SELECT
            fp.post_id,
            fp.post_title,
            pc.content      AS post_chunk,
            (
                $5 * (1.0 / (1.0 + (pc.embedding <-> $3::vector)))
                + $6 * (1.0 / (1.0 + (pte.embedding <-> $3::vector)))
            )               AS similarity_score
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
    speech_tone: int | None = -1,
    limit: int = 5,
) -> AsyncIterator[str]:
    
    # 질문 임베딩
    q_embed = (await embed_texts([question]))[0]

    # 제목 + 본문 청크 하이브리드 검색
    # similar_chunks 호출 시 기본 임계값(0.6)이 사용됨 (사용자 코드에서는 0.2으로 지정)

    # 기본 말투 옵션
    speech_tone_for_llm_1 = "전문성있게 간단하고 명료하게 설명해"
    speech_tone_for_llm_2 = "아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해"

    if speech_tone == -1:
        speech_tone_for_llm = speech_tone_for_llm_1
    elif speech_tone == -2:
        speech_tone_for_llm = speech_tone_for_llm_2
    else:
        # speech_tone이 -1 또는 -2가 아닌 경우, 데이터 베이스에서 해당 말투를 가져와 전달
        persona_id = int(speech_tone)
        pool = await get_pool()
        sql = """
            SELECT name, description 
            FROM persona
            WHERE id = $1;
        """
        row = await pool.fetchrow(sql, persona_id)
        if row:
            speech_tone_for_llm = f"{row['name']}: {row['description']}"
        else:
            speech_tone_for_llm = speech_tone_for_llm_1

    # 예외 처리: 만약 유사 청크 검색이 실패하면, 기본 임계값(0.2)으로 다시 시도    
    try:
        similar_data = await similar_chunks(
            q_embed,
            user_id,
            category_id,
            limit,
            alpha=0.7,
            beta=0.3,
            similarity_threshold=0.2,# 다른 임계값을 사용하고 싶다면 여기서 지정 (사용자 지정값 유지)
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
    if not existInPost:            # 연관 포스트가 없을 때
        context_chunks: list[dict] = []          # 빈 리스트
    else:
        context_chunks = [
            {
                "text":  item["post_chunk"],           # 청크 본문
                "score": item.get("similarity_score", 0.0),   # 선택: 유사도
                "title": item["post_title"]            # 선택: 제목(디버깅용)
            }
            for item in similar_data
        ]

    # 프롬프트 구성
    # --------- System 메시지 (불변 규칙) ---------
    system_prompt = """
    당신은 블로그 운영자 AI입니다. 사용자의 블로그에 대한 질문에 답변합니다. 
    블로그 운영자 AI는 사용자의 질문에 대해 블로그 본문 컨텍스트를 참고하여 답변합니다.

    모든 한국어 응답은 무슨일이 있어도 반드시 답변 말투 및 규칙을 따릅니다. 

    또한 주어진 내용외의 내용을 지어내지 마십시오.
    
    [응답 규칙]
    1. 만약 제목과 본문을 활용해 답변할 수 있다면 답변 말투 및 규칙을 지켜 직접 답변하고, 마지막에 추가적인 내용에 대한 질문을 유도하는 문장을 추가합니다.

    2. 만약 질문이 욕설·비난·무관·부적절하거나 주어진 제목, 본문과 관련이 없다면 사과와 블로그 관련된 내용만 답변 가능하다는 내용을 답변 말투 및 규칙을 지켜 답합니다.  

    3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면  
    report_content_insufficient 함수를 호출하고 답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다.
    그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 
    해당 내용에 대한 질문을 직접적으로 유도합니다. 
 
    """

    # --------- User 메시지  ---------
    user_message = f"""
        블로그 카테고리: {', '.join(category_names)}
        카테고리들을 참고해 해당 블로그가 어떤 블로그인지 파악하고 대답하세요.

        답변 말투 및 규칙: "{speech_tone_for_llm}"
        반드시 말투 및 규칙에 따라 대답하세요!

        아래의 질문과 블로그 본문 컨텍스트를 참고하여 답변하세요.
        사용자의 질문: {question}

        가장 근접한 블로그 본문 컨텍스트:
        {json.dumps(context_chunks, ensure_ascii=False, indent=2)}
    """
   
    # --------- messages 배열 ---------
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": user_message.strip()}
    ]

    # --------- Function Calling ---------
    tools = [
        {
            "type": "function",
            "function": {
                "name":        "report_content_insufficient",
                "description": "카테고리는 맞지만 본문 컨텍스트가 부족할 때 호출",
                "parameters":  {
                    "type":       "object",
                    "properties": {
                        "text": { "type": "string", "description": "답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다." },
                        "need_follow_up": { "type": "boolean" }
                    },
                    "required": ["text"]
                }
            }
        }
    ]

    # finish_reason에 따라 한 번만 end 이벤트를 보내기 위한 플래그
    end_event_sent = False  # finish_reason에 따라 end 이벤트 한 번만 전송하기 위한 플래그
    resp = await client.chat.completions.create(
        model=settings.chat_model,
        stream=True,
        messages=messages,
        tools=tools,
        tool_choice="auto",
    )
    # current_tool_call_id = None # 사용자 코드 위치 및 변수 선언 유지
    # current_function_name = None # 사용자 코드 위치 및 변수 선언 유지
    # current_arguments_str = "" # 사용자 코드 위치 및 변수 선언 유지
    

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
        if delta.content:
            # chunk 단위로 partial text를 보내거나, JSON으로 래핑해서 보낼 수 있습니다
            yield "event: answer\n"
            yield f"data: '{delta.content}'\n\n"

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
