# Bubblog AI API 문서 (v1 ~ v2)

본 문서는 `/ai` (v1)와 `/ai/v2` (v2) 엔드포인트를 정리합니다. 서버는 Express 기반이며, `POST /ask` 류는 Server‑Sent Events(SSE)로 답변을 스트리밍합니다.

## 기본 정보
- Base Path
  - v1: `/ai`
  - v2: `/ai/v2`
- 인증
  - `POST /ask` 엔드포인트는 `Authorization: Bearer <JWT>` 필요
  - 임베딩 생성 엔드포인트는 인증 없이 사용 가능
- 본문 형식: `application/json`
- SSE 수신: `Content-Type: text/event-stream`
  - 이벤트명은 `event:` 라인으로, 데이터는 `data:` 라인으로 전송됩니다.
  - 일반 텍스트 콘텐츠는 `event: answer`로 분할 전송되며, 종료 시 `event: end` + `data: [DONE]`가 송신됩니다.

## v1 엔드포인트 (`/ai`)

### GET `/ai/health`
- 인증: 불필요
- 응답(200): `{ "status": "ok" }`

### POST `/ai/embeddings/title`
- 인증: 불필요
- 요청 Body
  - `post_id`(number, required)
  - `title`(string, required)
- 동작: 제목 임베딩 생성 후 저장
- 응답(200): `{ "ok": true }`

### POST `/ai/embeddings/content`
- 인증: 불필요
- 요청 Body
  - `post_id`(number, required)
  - `content`(string, required)
- 동작: 본문을 약 512 토큰 단위로 중첩(50) 청킹 → 임베딩 생성/저장
- 응답(200): `{ "post_id": number, "chunk_count": number, "success": true }`

### POST `/ai/ask` (SSE)
- 인증: 필요 (`Authorization: Bearer <JWT>`)
- 요청 Body
  - `question`(string, required)
  - `user_id`(string, required)
  - `category_id`(number, optional)
  - `post_id`(number, optional) — 지정 시 해당 글 컨텍스트에 국한하여 답변
  - `speech_tone`(number, optional)
    - `-1`: 간결하고 명확한 말투(기본)
    - `-2`: 해당 글의 말투를 최대한 모사
    - 양의 정수: 페르소나 ID(해당 유저의 등록된 페르소나 참조)
  - `llm`(object, optional)
    - `provider`: `openai` | `gemini`
    - `model`: string (미지정 시 서버 기본값 사용)
    - `options`: `{ temperature?, top_p?, max_output_tokens? }`
- SSE 이벤트(주요)
  - `exist_in_post_status`: `true|false` — 관련 컨텍스트 존재 여부
  - `context`: `[ { postId, postTitle }, ... ]` — 검색/선택된 컨텍스트 요약
  - `answer`: 모델의 부분 응답 텍스트(여러 번 전송)
  - `end`: 종료 시 `data: [DONE]`
  - `error`: `{ code?, message }` — 예: `post_id`가 없거나 권한 없음(403), 없음(404)
- 예시(curl)
  ```bash
  curl -N \
    -H "Authorization: Bearer <JWT>" \
    -H "Content-Type: application/json" \
    -X POST http://localhost:3000/ai/ask \
    -d '{
      "question": "카테고리 A 관련 요약 해줘",
      "user_id": "u_123",
      "category_id": 1,
      "speech_tone": -1
    }'
  ```

## v2 엔드포인트 (`/ai/v2`)

### GET `/ai/v2/health`
- 인증: 불필요
- 응답(200): `{ "status": "ok", "v": "v2" }`

### POST `/ai/v2/ask` (SSE)
- 인증: 필요 (`Authorization: Bearer <JWT>`)
- 요청 Body
  - `question`(string, required)
  - `user_id`(string, required)
  - `category_id`(number, optional)
  - `post_id`(number, optional)
  - `speech_tone`(number, optional)
    - `-1`: 기본 말투(간결/명확)
    - `-2`: 해당 글(post 모드) 말투 모사
    - 양수: 페르소나 ID(해당 유저의 등록 페르소나)
  - `llm`(object, optional)
    - `provider`: `openai` | `gemini`
    - `model`: string (미지정 시 서버 기본값 사용)
    - `options`: `{ temperature?: number, top_p?: number, max_output_tokens?: number }`
- 동작 개요
  - 서버가 질문을 토대로 “검색 계획(JSON)”을 생성·검증·정규화한 뒤, 계획에 따라 시맨틱 또는 하이브리드 검색을 수행하고 결과를 SSE로 스트리밍합니다.
  - `post_id`가 있으면 post 모드(단일 글 컨텍스트)로 처리하며, 간략한 `search_plan`/`search_result` 이벤트 후 본문 기반 답변을 스트리밍합니다.
- 하이브리드 검색(벡터+텍스트)
  - 계획에 `hybrid.enabled: true`인 경우 활성화됩니다.
  - `rewrites`(재작성 질의)와 `keywords`(핵심 키워드)를 생성하여 벡터/텍스트 두 경로로 후보를 수집하고, `hybrid.retrieval_bias` 라벨을 서버가 `alpha` 값으로 매핑해 점수를 융합하여 상위 `top_k`를 선택합니다.
    - 매핑(기본): `lexical → 0.3`, `balanced → 0.5`, `semantic → 0.75`
    - 결합식: `score = alpha*vec + (1-alpha)*text` (각 경로 점수 min-max 정규화 후)
  - SSE로 `rewrite`, `keywords`, `hybrid_result` 이벤트가 필요한 경우에만 송신됩니다. 하이브리드 결과가 없으면 시맨틱 검색으로 폴백합니다.
- SSE 이벤트 순서(일반적인 흐름)
  1) `search_plan`: 정규화된 검색 계획(JSON)
     - 예시 데이터(정규화):
       ```json
       {
         "mode": "rag",
         "top_k": 5,
         "threshold": 0.2,
         "weights": { "chunk": 0.7, "title": 0.3 },
         "filters": {
           "time": { "type": "absolute", "from": "2025-09-01T00:00:00.000Z", "to": "2025-09-30T23:59:59.999Z" }
         },
         "sort": "created_at_desc",
         "limit": 5,
         "hybrid": { "enabled": true, "retrieval_bias": "balanced", "alpha": 0.5, "max_rewrites": 3, "max_keywords": 6 },
         "rewrites": ["프로젝트 X 요약", "프로젝트 X 핵심"],
         "keywords": ["프로젝트 X", "핵심", "요약"]
       }
       ```
       - 비고:
         - `filters.time`만 포함됩니다. `user_id`/`category_id`/`post_id` 등은 서버가 검색 시 내부적으로 적용합니다.
         - `hybrid.retrieval_bias`는 LLM 라벨이며 서버가 `alpha`로 변환해 사용합니다.
       - post 모드에서는 간략한 형태 예: `{ "mode": "post", "filters": { "post_id": 123, "user_id": "u_123" } }`.
  2) (하이브리드 사용 시) `rewrite`: `string[]`
  3) (하이브리드 사용 시) `keywords`: `string[]`
  4) (하이브리드 사용 시) `hybrid_result`: `[ { postId, postTitle }, ... ]`
  5) `search_result`: `[ { postId, postTitle }, ... ]` — 최종 컨텍스트 요약(하이브리드 또는 시맨틱)
  6) `exist_in_post_status`: `true|false`
  7) `context`: `[ { postId, postTitle }, ... ]`
  8) `answer` — 모델 부분 응답(여러 번)
  9) `end` — `data: [DONE]`
  - 오류 시 `error`: `{ code?: number, message: string }`
- 폴백 동작
  - 플래너 실패 시 `search_plan`으로 `{ "mode": "rag", "fallback": true }`가 송신되며, v1 스타일 RAG로 컨텍스트를 구성합니다.

- 예시(curl)
  ```bash
  curl -N \
    -H "Authorization: Bearer <JWT>" \
    -H "Content-Type: application/json" \
    -X POST http://localhost:3000/ai/v2/ask \
    -d '{
      "question": "최근 한 달 블로그에서 프로젝트 X 관련 내용 요약",
      "user_id": "u_123",
      "category_id": 3,
      "llm": { "provider": "openai", "model": "gpt-5-mini", "options": { "temperature": 0.2, "top_p": 0.9, "max_output_tokens": 800 } }
    }'
  ```

## 참고 사항
- `post_id`가 지정된 요청에서 해당 글이 존재하지 않으면 SSE로 `error` 이벤트(404)가 송신되고 스트림이 종료됩니다.
- `post.is_public`이 `false`인 글은 요청 `user_id`가 글 소유자와 다르면 `error` 이벤트(403)로 차단됩니다. `post.is_public`이 `true`면 누구나 접근 가능합니다.
- v1/v2 모두 모델 응답 텍스트는 `answer` 이벤트로 분할 전송됩니다. 클라이언트는 누적하여 최종 답변을 구성해야 합니다.
- EventSource(브라우저) 사용 예시
  ```js
  const es = new EventSource('/ai/v2/ask', { withCredentials: true }); // 헤더 인증이 필요한 경우 fetch/XHR 권장
  es.addEventListener('search_plan', (e) => console.log('plan', e.data));
  es.addEventListener('search_result', (e) => console.log('result', e.data));
  es.addEventListener('context', (e) => console.log('ctx', e.data));
  es.addEventListener('answer', (e) => renderAppend(JSON.parse(e.data)));
  es.addEventListener('end', () => es.close());
  es.addEventListener('error', (e) => es.close());
  ```

## 요약
- v1 `/ai/ask`: 컨텍스트 존재 여부와 요약(`exist_in_post_status`, `context`) 후 답변 스트리밍
- v2 `/ai/v2/ask`: 위 흐름에 더해 검색 계획(`search_plan`)과 검색 결과 요약(`search_result`)을 추가로 제공
- 임베딩 API(v1): 게시물 제목/본문 임베딩 생성 및 저장
