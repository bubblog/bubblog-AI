# ASK 세션 관리 및 대화 이력 저장 계획

## 1. 목표와 배경
- `/ai/v2/ask` 흐름에 “세션” 개념을 도입해 질문·응답 히스토리를 영속화하고, LLM 호출 시 과거 맥락을 재활용한다.
- 하이브리드 검색/플래너 구조는 유지하되, 세션별 메타데이터와 메시지를 저장해 대화형 UX를 지원한다.
- `/ai/v1/ask` 경로도 동일한 세션/캐시 메커니즘을 공유하도록 범위를 확장하며, v1과 v2 모두 동일한 저장소/히스토리 API를 사용한다. `session_id` 없이 호출된 경우 서버가 즉시 신규 세션을 생성해 클라이언트에 식별자를 돌려준다.

## 2. 요구사항 & 고려 사항
- **세션 수명**: 클라이언트가 `session_id`를 생략하거나 `null`로 보낼 때만 서버가 신규 세션을 생성하고 식별자를 반환한다. 값이 있는 `session_id`는 항상 기존 세션을 재사용한다.
- **사용자 식별**: 세션/히스토리 소유권은 반드시 `authMiddleware`가 디코딩한 JWT의 `user_id` 클레임으로 판별한다. `/ai/(v1|v2)/ask` 요청 본문의 `user_id`는 “어떤 블로그의 챗봇을 질의하느냐”를 뜻하는 `owner_user_id`로 DB에 별도 저장한다. 세션/메시지 레코드는 항상 `(requester_user_id, owner_user_id)` 쌍을 유지해 접근 제어(요청자 기준)와 캐시/무효화(블로그 주인 기준)를 동시에 지원한다.
- **세션 생성 전제**: 새 세션을 만들려면 반드시 목표 챗봇(= `owner_user_id`)을 명시해야 한다. `/ai/(v1|v2)/ask` 요청에서 `session_id`가 없거나 null일 때만 서버가 새 세션을 자동 생성하며, 이후 세션이 속한 모든 메시지·임베딩에는 동일한 `owner_user_id`가 저장된다. 별도의 세션 생성 API는 제공하지 않는다.
- **Owner 일관성 검증**: 클라이언트가 `/ai/(v1|v2)/ask`에 `session_id`와 `user_id`를 동시에 보낼 때 두 값이 가리키는 owner가 다르면 요청을 즉시 400/409로 거부한다(프런트에서도 다른 owner로 세션 다시 쓰기를 금지). 서버는 DB에 저장된 세션의 `owner_user_id`를 단일 진실 소스로 신뢰하며, Body의 값과 일치할 때만 진행한다.
- **히스토리 저장**: 사용자 질문, 검색 계획 요약, 모델 답변 요약본 등 최소 정보는 DB에 보관. 토큰 비용을 고려해 원문 전체 저장 여부 판단.
- **프롬프트 구성**: 세션의 최근 N개 대화를 불러와 RAG 컨텍스트 뒤에 배치하되, 총 토큰 한도를 넘지 않도록 절단 로직 필요.
- **하이브리드/플래너 영향**: 검색 계획은 여전히 질문 단위로 생성하지만, 과거 대화에서 follow-up intent 판단에 활용될 수 있도록 프롬프트 확장 검토.
- **SSE 계약**: 세션 생성/갱신 이벤트를 추가해 클라이언트가 새 세션을 추적할 수 있게 한다.
- **보안·정합성**: 사용자별 세션 접근 제어 필요. 세션 삭제/만료 정책과 개인정보(민감 답변) 취급 주의.
- **v1/v2 공통 처리**: `/ai/v1/ask`는 검색 계획이나 하이브리드 메타가 없을 수 있으므로 저장 시 `search_plan`/`retrieval_meta`를 `NULL`로 허용하고, 히스토리 API에서 두 경로가 동일한 스키마를 사용한다.

## 3. 작업 단계
1. **DB 설계 & 마이그레이션**
   - `ask_session` 테이블 추가 (PostgreSQL)  
     ```sql
     CREATE TABLE ask_session (
       id BIGSERIAL PRIMARY KEY,
       requester_user_id TEXT NOT NULL, -- JWT에서 파생된 실제 질문자
       owner_user_id TEXT NOT NULL,     -- 챗봇/블로그 주인
       title TEXT,
       metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
       last_question_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     
     CREATE INDEX idx_ask_session_requester_created_at
       ON ask_session (requester_user_id, created_at DESC);
     CREATE INDEX idx_ask_session_owner_created_at
       ON ask_session (owner_user_id, created_at DESC);
     CREATE INDEX idx_ask_session_last_question_at
       ON ask_session (last_question_at DESC NULLS LAST);
     ```
   - `ask_message` 테이블 추가 (PostgreSQL)  
     ```sql
     CREATE TABLE ask_message (
       id BIGSERIAL PRIMARY KEY,
       session_id BIGINT NOT NULL REFERENCES ask_session(id) ON DELETE CASCADE,
       role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
       content TEXT NOT NULL,
       search_plan JSONB,
       retrieval_meta JSONB,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     
     CREATE INDEX idx_ask_message_session_created_at
       ON ask_message (session_id, created_at DESC, id DESC);
     ```
     - 각 메시지의 소유권은 `ask_session`을 통해 추적되므로 `ask_message`에는 별도의 `requester_user_id`/`owner_user_id` 컬럼이 없다.
   - `ask_message_embedding` 테이블 추가 (PostgreSQL, `pgvector` 필요)  
     ```sql
     CREATE EXTENSION IF NOT EXISTS vector;
     
     CREATE TABLE ask_message_embedding (
       message_id BIGINT PRIMARY KEY REFERENCES ask_message(id) ON DELETE CASCADE,
       owner_user_id TEXT NOT NULL,
       requester_user_id TEXT NOT NULL,
       category_id BIGINT,
       post_id BIGINT,
       answer_message_id BIGINT REFERENCES ask_message(id),
       embedding vector(1536) NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     
     CREATE INDEX idx_ask_message_embedding_owner ON ask_message_embedding (owner_user_id);
     CREATE INDEX idx_ask_message_embedding_owner_category ON ask_message_embedding (owner_user_id, category_id);
     CREATE INDEX idx_ask_message_embedding_owner_post ON ask_message_embedding (owner_user_id, post_id);
     CREATE INDEX idx_ask_message_embedding_requester ON ask_message_embedding (requester_user_id);
     CREATE INDEX idx_ask_message_embedding_vec ON ask_message_embedding USING ivfflat (embedding vector_cosine_ops);
     ```
     - 벡터 차원(1536)은 현재 `text-embedding-3-small` 모델에 맞추며, 당장은 코드/마이그레이션 모두 하드코딩 값으로 유지한다.
     - `owner_user_id`는 챗봇 주인 ID로, 블로그 콘텐츠 재임베딩 시 이 값을 기준으로 `ask_message_embedding` 레코드를 일괄 삭제한다. `requester_user_id`는 동일 사용자가 반복 질문할 때 캐시를 재사용하기 위한 용도로 유지한다.
     - `category_id`와 `post_id`는 모두 NULL 허용 값이며, `/ai/ask` 요청 파라미터에 따라 한 쪽만 채워질 수도 있다. 이 값을 그대로 저장해 KNN 검색 시 SQL where 조건으로 필터링한다.
     - 인덱스 설계  
       - `ask_session`: `(requester_user_id, created_at DESC)`, `(owner_user_id, created_at DESC)`, `last_question_at DESC` (최근 세션/대상별 리스트용).  
       - `ask_message`: `(session_id, created_at DESC, id DESC)` 커버링 인덱스만 유지해 세션 단위 페이지네이션을 지원.  
   - 마이그레이션/롤백 스크립트 작성 후 `docs/migrations`에 설명 추가.

2. **Repository/Service 계층 추가**
   - `src/repositories/ask-session.repository.ts`(세션 CRUD, 최신 메시지 조회).
   - `src/repositories/ask-message.repository.ts`(메시지 insert/조회).
   - 트랜잭션 지원이 필요하면 `db.ts` 활용해 래퍼 제공.

3. **세션 식별/제목 로직**
   - `askV2Handler`에서 `session_id` 파라미터 읽기. 없으면 세션을 생성하고 첫 사용자 질문을 제목으로 삼아 저장 → SSE `session` 이벤트로 ID 및 제목 전달.
   - `PATCH /ai/v2/sessions/:id`에서 제목, metadata를 수정할 수 있도록 repository/서비스 레이어 포함(보관/복구 없이 항상 실제 삭제).
   - 사용자 검증: 전달된 세션이 JWT에서 파생된 `requester_user_id`와 일치하는지 검사 후 진행.

4. **대화 히스토리 로드**
   - `answerStreamV2` 시작 시 최근 메시지 N개 조회 (정책: 최신 2개 turn만 사용).
   - LLM 메시지 배열 구성 시 `qaPrompts`에 히스토리를 prepend(역순 정렬 주의). 별도 토큰 계산 없이 2개 turn을 그대로 포함하고, 보다 엄격한 한도가 필요해지면 `utils/tokenizer` 기반 토큰 검사 추가.

5. **검색 계획과 히스토리 연결**
   - Follow-up 질문 식별을 위해 `buildSearchPlanPrompt`에 “이전 대화” 섹션 옵션 추가.
   - 하이브리드 검색은 현재 질문과 재작성으로 수행하되, 필요 시 세션의 마지막 답변 제목 등을 참고하도록 확장 가능.

6. **SSE 전송 구조 업데이트**
   - 세션 생성 시 `event: session` → `{ session_id, owner_user_id, requester_user_id }`를 한 번 송신하고 응답 헤더(`session-id`)도 함께 세팅한다.
   - 스트림 완료 시 `event: session_saved` → `{ session_id, owner_user_id, cached: boolean }`, 실패 시 `event: session_error` → `{ session_id, owner_user_id, reason }`를 전송한다.
   - 나머지 이벤트(`search_plan`, `search_result`, `context`, `answer`, `rewrite`, `keywords`, ...)의 payload 구조는 기존과 동일하며 문서만 보강한다.

7. **메시지 & 임베딩 저장 파이프라인**
   - 질문이 유입되면 즉시 `createEmbeddings([question])`로 질문 벡터를 생성하고, 중복 질문 KNN 검사/검색 플로우/최종 저장까지 같은 벡터를 재사용한다(v1 RAG, v1 단일 포스트, v2 하이브리드 공통).
   - SSE가 정상 종료될 때까지 사용자 질문, 검색 계획 요약, 요청 범위(`category_id`/`post_id`), 세션 ID, 생성된 임베딩, 최종 답변 텍스트를 메모리(또는 임시 버퍼)에 보관한다. 구현은 스트리밍을 지연시키지 않도록 하고, `answerStream`/`answerStreamV2`에서 LLM 청크를 즉시 클라이언트로 흘리되 동시에 `bufferedAnswer += chunkString` 형태로 누적 문자열을 유지하는 간단한 메모리 버퍼를 둔다.
   - 스트림 종료 직전에 단일 트랜잭션을 열어 `ask_message`(user) → `ask_message`(assistant) → `ask_message_embedding` 순으로 한 번에 INSERT/UPDATE를 수행해 트랜잭션 시간을 최소화한다. v1 플로우에서는 검색 계획 관련 필드가 비어 있을 수 있으므로 NULL 허용/기본값 로직을 통일한다.
   - 검색/하이브리드 파이프라인에서 이미 생성한 “질문 원문” 임베딩을 재사용해 `ask_message_embedding`을 저장하고, 같은 트랜잭션에서 `answer_message_id`를 세팅한다. `/ai/ask`에서 `post_id`가 지정된 단일 포스트 질문도 동일한 세션/캐시 흐름에 참여시키기 위해 질문 원문을 별도로 임베딩해 저장한다(내부 `createEmbeddings` 호출 재사용).
   - 사용자 블로그 콘텐츠가 재임베딩되면 이전 답변의 근거가 달라질 수 있으므로, 임베딩 워커에서 특정 블로그 주인(=owner)의 포스트 임베딩을 재계산한 직후 `ask_message_embedding` 테이블에서 해당 `owner_user_id`의 모든 레코드를 일괄 삭제한다(트랜잭션 고려, 삭제 실패 시 로그만 남기고 본 작업은 계속). `queue-consumer`는 `findPostById`로 이미 포스트와 소유자 정보를 조회하므로 이를 활용하고, 삭제 실패는 try/catch로 감싼다.
   - 스트림 도중 에러가 발생하거나 클라이언트가 연결을 끊으면 해당 질문/답변/임베딩을 모두 버리고 트랜잭션을 열지 않는다(불완전 대화는 저장하지 않음). 저장 중 오류 발생 시에도 트랜잭션을 롤백하고 스트림에는 영향을 주지 않으며, 경고 로그와 메트릭을 남겨 재시도/모니터링한다.

8. **중복 질문 선별 & 재사용**
   - 새 질문 수신 시 `ask_message_embedding`에서 동일 사용자 범위로 KNN 검색을 수행하고, `category_id`/`post_id` 컬럼을 이용해 현재 요청과 동일한 범위만 후보로 제한한다(예: `post_id`가 존재하면 해당 값 동일 조건, 없으면 `category_id` 비교).  
     ```sql
     SELECT message_id, answer_message_id, 1 - (embedding <=> $1) AS similarity
     FROM ask_message_embedding ame
     WHERE ame.owner_user_id = $2
       AND ame.requester_user_id = $3
       AND (
         ($4::bigint IS NOT NULL AND ame.post_id = $4)
         OR
         ($4::bigint IS NULL AND ame.post_id IS NULL AND ame.category_id IS NOT DISTINCT FROM $5::bigint)
       )
     ORDER BY ame.embedding <-> $1
     LIMIT 3;
     ```
   - 상위 후보의 similarity(코사인 기준)를 계산하여 0.92~0.95 이상이고 필터 조건이 완전히 일치할 때 동일 질문으로 간주하고, 이미 저장된 `search_plan`/`retrieval_meta`/`answer` 스냅샷을 이용해 최초 질의와 동일한 이벤트 시퀀스(`search_plan` → `search_result`/`context` → `answer` → `session_saved`)를 그대로 재생한다.
   - `/ai/ask`와 `/ai/v2/ask` 모두 요청 본문의 `post_id`가 있으면 임베딩 레코드의 `post_id`를 채우고, 없으면 `category_id`를 채운다(두 값이 모두 없으면 NULL). 이 설계를 기반으로 KNN 검색 시 `WHERE owner_user_id = $owner AND requester_user_id = $requester AND post_id IS NOT DISTINCT FROM $postId AND category_id IS NOT DISTINCT FROM $categoryId` 조건을 적용한다.
   - 임계값 미달 또는 저장된 응답이 없을 경우 기존 검색/LLM 플로우로 진행.

9. **테스트 & 관측성**
   - 리포지토리 단위 테스트: 세션 생성, 메시지 삽입/조회, 임베딩 저장/업데이트.
   - 서비스 통합 테스트: 세션 없는 요청 → 생성 확인, 기존 세션 요청 → 히스토리 포함 프롬프트 검증, 유사 질문 반복 시 캐시된 답변 반환 확인.
   - 디버그 로그에 `session_id`와 재사용 여부(`qa_cached: true/false`) 추가해 추적성 확보.

10. **문서 & 마이그레이션 가이드**
   - `docs/history-tasks`에 세션 도입 배경/사용법 기록.
   - 운영 배포 시 주의사항(마이그레이션 순서, 롤백 절차, `pgvector` 설치) 설명.

## 4. 무한 스크롤 메시지 API 상세
- **엔드포인트**: `GET /ai/v2/sessions/:sessionId/messages`
- **쿼리 파라미터**
  - `cursor?: string` → `created_at` ISO 문자열과 `id` 조합을 Base64로 인코딩 (`${created_at}|${id}`)해 전달.
  - `direction?: 'backward' | 'forward'` → 무한 스크롤 UX에 맞춰 과거(`backward`, default) 또는 이후(`forward`) 로딩 지원.
  - `limit?: number` → 기본 20, 최대 50.
- **응답**
  ```json
  {
    "session_id": "123",
    "messages": [
      {
        "id": "456",
        "role": "user",
        "content": "...",
        "created_at": "2025-01-19T10:05:12.123Z",
        "search_plan": {...},
        "retrieval_meta": {...}
      }
    ],
    "paging": {
      "direction": "backward",
      "has_more": true,
      "next_cursor": "MjAyNS0wMS0xOVQxMDowNToxMi4xMjNa|456"
    }
  }
  ```
- **PostgreSQL 조회 예시**
  ```sql
  WITH cursor_values AS (
    SELECT
      (split_part($1, '|', 1))::timestamptz AS cursor_created_at,
      (split_part($1, '|', 2))::bigint      AS cursor_id
  )
  SELECT *
  FROM ask_message am
  WHERE am.session_id = $2
    AND (
      $3 = 'forward' AND (
        am.created_at > (SELECT cursor_created_at FROM cursor_values) OR
        (am.created_at = (SELECT cursor_created_at FROM cursor_values) AND am.id > (SELECT cursor_id FROM cursor_values))
      )
      OR
      $3 <> 'forward' AND (
        am.created_at < (SELECT cursor_created_at FROM cursor_values) OR
        (am.created_at = (SELECT cursor_created_at FROM cursor_values) AND am.id < (SELECT cursor_id FROM cursor_values))
      )
      OR $1 IS NULL
    )
  ORDER BY
    CASE WHEN $3 = 'forward' THEN am.created_at END ASC,
    CASE WHEN $3 <> 'forward' THEN am.created_at END DESC,
    am.id DESC
  LIMIT $4;
  ```
- **서버 로직**
  1. `authMiddleware`에서 파생된 사용자 ID와 세션 소유권을 비교.
  2. `cursor` 미전달 시 최신 메시지를 기준으로 `backward` 모드 페이징.
  3. 응답 `messages`는 API 레이어에서 시간순 정렬(무한 스크롤 라이브러리 요구사항에 맞춰 전/후 정렬 선택).
  4. `has_more`는 조회 개수가 `limit`와 같을 때 true, `next_cursor`는 목록의 마지막 항목에서 생성.
  5. 대화가 비어 있으면 빈 배열과 `has_more: false` 반환.

## 5. API 추가/변경 사항

### 5.1 `/ai/v1/ask`, `/ai/v2/ask`
- **Request Body (공통)**  
  ```json
  {
    "question": "string",
    "user_id": "owner_user_id",        // 챗봇/블로그 주인 (새 세션 생성 시 필수)
    "session_id": "optional string",   // 기존 세션 ID, 없으면 서버가 새로 생성
    "category_id": 123,                // optional, follow-up 필터
    "post_id": 456,                    // optional, 단일 포스트 질문
    "speech_tone": -1,
    "llm": { ... }                     // existing override 구조
  }
  ```
- **동작**  
  - 컨트롤러는 JWT의 `user_id` 클레임을 `requester_user_id`로 사용하고 Body의 `user_id`를 `owner_user_id`로 매핑한다.  
  - `session_id`가 없으면 `owner_user_id`가 반드시 포함되어야 하며 서버가 즉시 새로운 세션을 생성한다. `session_id`가 전달되면 `owner_user_id`는 optional이지만, 전달된 경우 세션이 가리키는 owner와 일치해야 한다.  
  - 신규 세션 생성 시 SSE 첫 이벤트(`event: session`)와 응답 헤더(`session-id`)에 ID를 반환하고, 캐시 저장 성공/실패 여부는 별도 이벤트로 통지한다.
- **Response / SSE 계약**  
  - 기존 `search_plan`/`search_result`/`answer` 등 이벤트 payload 형식은 변경하지 않는다.  
  - 신규 세션이 만들어졌을 때만 `event: session` → `{ session_id, owner_user_id, requester_user_id }`를 전송한다.  
  - 스트림 종료 시 히스토리 영속화/캐시 여부를 알려주는 `event: session_saved` 또는 오류 시 `event: session_error`를 송신한다.

### 5.2 REST 세션 API

| Endpoint | Method | 목적 |
|----------|--------|------|
| `/ai/v2/sessions` | GET  | 요청자 기준 세션 목록 조회 |
| `/ai/v2/sessions/:id` | GET | 단일 세션 메타 조회(옵션) |
| `/ai/v2/sessions/:id/messages` | GET | 세션 메시지 히스토리 페이지네이션 |
| `/ai/v2/sessions/:id` | PATCH | 세션 제목/메타데이터 수정 |
| `/ai/v2/sessions/:id` | DELETE | 세션 및 메시지 삭제 |

> 세션 생성은 `/ai/(v1|v2)/ask` 호출에서 `session_id`가 없거나 null일 때만 허용되므로 별도의 POST 엔드포인트는 제공하지 않는다.

#### GET `/ai/v2/sessions`
- **Query Params**
  - `limit` (default 20, max 50)
  - `cursor` (optional, Base64 `${created_at}|${id}`)
  - `owner_user_id` (optional) → 특정 챗봇만 필터링
- **Response 200**
  ```json
  {
    "sessions": [
      {
        "session_id": "123",
        "owner_user_id": "user-abc",
        "requester_user_id": "req-xyz",
        "title": "first question",
        "metadata": {},
        "last_question_at": "2025-01-19T10:05:12.123Z",
        "message_count": 4
      }
    ],
    "paging": {
      "cursor": "base64",
      "has_more": true
    }
  }
  ```
- **Behaviour**: 항상 requester 기준으로만 조회, owner 필터가 있으면 `owner_user_id = $owner` 조건 추가.

#### GET `/ai/v2/sessions/:id`
- **Purpose**: 단일 세션 메타데이터를 조회해 클라이언트가 세션 헤더를 갱신할 때 사용.
- **Response 200**
  ```json
  {
    "session_id": "123",
    "owner_user_id": "user-abc",
    "requester_user_id": "req-xyz",
    "title": "first question",
    "metadata": {},
    "created_at": "...",
    "updated_at": "...",
    "last_question_at": "...",
    "message_count": 4
  }
  ```
- 세션이 requester에게 속하지 않으면 404 (존재 은닉).

#### GET `/ai/v2/sessions/:id/messages`
- 이미 4장에서 상세히 정의된 무한 스크롤 스펙 사용.  
- **Response**: `session_id`, `owner_user_id`, `messages`, `paging`. 각 메시지는 `{ id, role, content, search_plan, retrieval_meta, created_at }`.

#### PATCH `/ai/v2/sessions/:id`
- **Body**
  ```json
  {
    "title": "optional string",
    "metadata": { ... }   // optional JSON object
  }
  ```
- **Validation**: `owner_user_id`는 수정 불가. Metadata는 JSON object만 허용(primitive/array 거부). 빈 요청이면 400.
- **Response 200**
  ```json
  {
    "session_id": "123",
    "owner_user_id": "user-abc",
    "title": "updated title",
    "metadata": { "topic": "infra" },
    "updated_at": "..."
  }
  ```

#### DELETE `/ai/v2/sessions/:id`
- **Response 200**
  ```json
  {
    "session_id": "123",
    "deleted": true
  }
  ```
- 삭제 시 `ask_message`/`ask_message_embedding`가 ON DELETE CASCADE로 정리되므로, 워커나 캐시와의 동기화는 별도 훅 없이 로그로만 남긴다.

### 5.3 추가 고려 사항
- API 응답 스키마를 `docs/history-tasks` 혹은 OpenAPI 스펙에 반영.  
- 모든 세션 관련 REST 엔드포인트는 `authMiddleware`로 `requester_user_id`를 추출하며, 본문에서 이 값을 받지 않는다. `owner_user_id`는 세션 생성 시 결정되며 이후 PATCH에서도 수정할 수 없다(필요 시 세션 삭제 후 재생성).  
- 모바일/웹 클라이언트가 SSE 없이 REST만으로도 히스토리를 로드할 수 있도록 설계하고, SSE가 종료된 뒤 REST 히스토리와 일관성 있게 동작하도록 `session_saved`/`session_error` 이벤트를 표준화한다.

## 6. 추후 확장 아이디어
- 세션 제목 자동 생성(첫 질문 혹은 LLM 요약 활용).
- 메시지 요약/압축 작업을 위한 비동기 워커 도입.
- 세션 검색 UI 제공을 위한 인덱싱(예: pg_trgm) 적용.
- 멀티 디바이스 동기화를 위한 마지막 읽은 위치(last_seen_at) 관리.

## 7. 커밋 단위 구현 계획
1. **chore: add ask session/message schemas**  
   - `ask_session`, `ask_message`, `ask_message_embedding` 테이블과 관련 인덱스/확장(pgvector, GIN, IVFFlat) 마이그레이션 추가.  
   - `docs/migrations/README.md`에 적용/롤백 방법과 의존성(pgvector 설치 등) 문서화.
2. **chore: db helpers & config prep**  
   - `db.ts`에 트랜잭션 헬퍼/유틸 추가, 공통 PG 타입 정의.  
   - Lint/tsconfig가 신규 파일을 해석하도록 배치하고, 최소 테스트 러너(예: Jest 스켈레톤) 추가.
3. **feat: session repositories**  
   - `ask-session.repository.ts`, `ask-message.repository.ts`, `ask-message-embedding.repository.ts` 작성.  
   - 커서 기반 조회, 세션 소유권 검사, 임베딩 insert/upsert 로직 포함.
4. **feat: session REST APIs**  
   - `/ai/v2/sessions` 목록/단일 조회, `/ai/v2/sessions/:id/messages` 무한 스크롤, `/ai/v2/sessions/:id` PATCH/DELETE 라우터/컨트롤러 + 요청 스키마 추가.  
   - JWT 파생 사용자 ID를 전제로 하고, 응답/문서 업데이트 포함. (POST 엔드포인트는 없음)
5. **feat: ask endpoints auth & session plumbing**  
   - `/ai/ask`, `/ai/v2/ask`에서 바디 `user_id`와 JWT `requester_id`를 명시적으로 구분.  
   - `session_id`가 없거나 null일 때만 새 세션을 만들고, 존재하면 해당 세션/owner 일관성을 검증한다.  
   - `session_id` 파라미터 처리, SSE `session` 이벤트/헤더 전송, 질문 범위(`category_id`/`post_id`)와 `owner_user_id` 파생 로직 도입.
6. **feat: history hydration & persistence**  
   - `answerStream`/`answerStreamV2`에서 최신 2턴 히스토리를 로드해 프롬프트에 prepend.  
   - SSE 청크를 즉시 전송하면서 메모리 버퍼에 누적하고, 스트림 종료 시 질문/답변/임베딩을 단일 트랜잭션으로 저장.
7. **feat: duplicate question cache & embeddings**  
   - 질문 벡터 생성·재사용, `ask_message_embedding` KNN 조회, `category_id`/`post_id` 동일 시 기존 답변 재생산.  
   - 캐시 적중 시 저장된 `search_plan`/`retrieval_meta`/`answer`를 사용해 기존 이벤트 시퀀스를 그대로 재생하고, 미적중 시 새 임베딩/답변을 저장해 캐시 여부를 로그로 노출.
8. **feat: embedding worker invalidation**  
   - `queue-consumer.ts`에서 동일 사용자 포스트 재임베딩 시 해당 `ask_message_embedding` 레코드 일괄 삭제.  
   - 실패 시 재시도/로그 처리, 단위 테스트 포함.
9. **docs/test: usage and coverage**  
   - `docs/history-tasks` 및 README에 세션 흐름/SSE 이벤트 기록.  
   - 통합 테스트: 세션 생성→질문→히스토리 페이징, 캐시 적중, 롤백 경로 등을 검증.
