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
- 요청 Body (v1과 동일 스키마)
  - `question`(string, required)
  - `user_id`(string, required)
  - `category_id`(number, optional)
  - `post_id`(number, optional)
  - `speech_tone`(number, optional)
  - `llm`(object, optional)
- v2의 추가/변경 사항
  - 검색 계획 수립과 결과를 사전 이벤트로 투명하게 송신합니다.
  - `post_id` 지정 시에도 동일한 형태의 사전 이벤트를 간략히 제공합니다.
- SSE 이벤트 순서(일반적인 흐름)
  1) `search_plan`: 검색 계획 정보
     - 예시 데이터(정규화된 계획):
       ```json
       {
         "mode": "rag" | "post",
         "top_k": 5,
         "threshold": 0.2,
         "weights": { "chunk": 0.7, "title": 0.3 },
         "filters": { "user_id": "u_123", "category_ids": [1], "post_id": 10?, "time": {...}? },
         "sort": "created_at_desc",
         "limit": 5
       }
       ```
       - `time` 필터는 `relative|absolute|month|year|quarter` 타입을 지원하며, 값은 ISO8601 또는 숫자 조합입니다.
  2) (하이브리드 사용 시) `rewrite`: `["재작성 질의", ...]`
  3) (하이브리드 사용 시) `keywords`: `["핵심 키워드", ...]`
  4) (하이브리드 사용 시) `hybrid_result`: `[ { postId, postTitle }, ... ]` — 융합 기준 상위 결과 요약
  5) `search_result`: `[ { postId, postTitle }, ... ]` — 최종 컨텍스트 요약
  6) `exist_in_post_status`: `true|false`
  7) `context`: `[ { postId, postTitle }, ... ]` — 모델 프롬프트에 사용되는 컨텍스트 요약
  8) `answer` 스트리밍(여러 번)
  9) `end` with `data: [DONE]`
  - 오류 시 `error`: `{ code?, message }`

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
      "llm": { "provider": "openai", "options": { "temperature": 0.2 } }
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
