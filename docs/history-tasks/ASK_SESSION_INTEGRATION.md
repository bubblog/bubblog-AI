# ASK Session Integration Guide

이 문서는 프론트엔드가 새 ASK 세션/히스토리 기능을 활용하기 위해 필요한 API 계약과 구현 예시를 정리한 자료다. `/ai/ask`, `/ai/v2/ask` 스트림 요청부터 세션 REST 엔드포인트, 무한 스크롤 메시지 페이징까지 한 흐름으로 설명한다.

---

## 1. ASK 요청 흐름

### 1.1 세션 ID 확보/생성
1. 기존 세션을 재사용할 때는 세션 목록 API(`GET /ai/v2/sessions`)로 ID를 조회한 뒤 선택한다.
2. 새 세션을 만들려면 ASK 요청의 `session_id`를 `null`이거나 생략하고, `user_id`(챗봇 주인 ID)를 반드시 포함한다.
   - 서버가 자동으로 세션을 생성하고 다음을 반환한다.
     - HTTP 헤더 `session-id: <number>`
     - SSE `event: session` → `{ session_id, owner_user_id, requester_user_id }`
3. 새 ID를 받으면 프론트에서 상태에 저장하고 이후 요청에서는 `session_id`만 전달하면 된다. 이때 `user_id`는 optional이며, 보낸 경우 DB owner와 일치해야 한다.

### 1.2 `/ai/ask` / `/ai/v2/ask` SSE 요청 샘플

```http
POST /ai/v2/ask HTTP/1.1
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "question": "최근 인프라 포스트 요약해줘",
  "user_id": "blog-owner-123",   // 새 세션일 때 필수
  "session_id": null,            // null 또는 생략 → 세션 자동 생성
  "category_id": 42,
  "speech_tone": -2
}
```

스트림 이벤트 순서(상황에 따라 일부 생략):
1. `event: session` *(신규 세션인 경우)*  
2. `event: search_plan`  
3. `event: rewrite` / `event: keywords` *(하이브리드 일 때)*  
4. `event: search_result`, `event: search_result_meta`, `event: exist_in_post_status`, `event: context`  
5. `event: hybrid_result`, `event: hybrid_result_meta` *(필요 시)*  
6. `event: answer` (LLM 토큰이 들어있는 SSE)  
7. `event: session_saved` → `{ session_id, owner_user_id, requester_user_id, cached }`  
   - `cached: true`는 질문이 캐시 적중되어 기존 답변을 재사용했음을 의미  
8. 오류 시 `event: session_error`(reason 포함) + 기존 `event: error`

프론트에서는 `session_saved`/`session_error`를 기준으로 UI 상태(“보관 완료” 배지 등)를 갱신할 수 있다.

### 1.3 캐시 히트 처리
동일한 질문(같은 사용자와 필터)일 경우 서버가 자동으로 캐시를 재생한다.
- SSE로 `search_plan`/`search_result`/`answer`가 즉시 도착하고, `session_saved` 이벤트의 `cached`가 `true`.
- **프론트 액션은 일반 답변과 동일**: SSE 순서/값이 동일하게 재생되므로 별도 분기를 둘 필요는 없지만, `cached`를 활용해 “이전 답변을 재사용했습니다” 같은 안내를 띄울 수 있다.

---

## 2. 세션 REST API

### 2.1 목록 조회 `GET /ai/v2/sessions`
- 쿼리 파라미터  
  - `limit`: 기본 20, 최대 50  
  - `cursor`: Base64(`created_at|id`) 문자열  
  - `owner_user_id`: 특정 블로그/챗봇만 필터링할 때 사용
- 응답
```json
{
  "sessions": [
    {
      "session_id": 123,
      "owner_user_id": "blog-owner-123",
      "requester_user_id": "viewer-999",
      "title": "인프라 정리 질문",
      "metadata": {},
      "last_question_at": "2025-01-19T10:05:12.123Z",
      "created_at": "2025-01-19T09:55:00.000Z",
      "updated_at": "2025-01-19T10:05:12.123Z",
      "message_count": 4
    }
  ],
  "paging": {
    "cursor": "MjAyNS0wMS0xOVQxMDowNToxMi4xMjNa|123",
    "has_more": true
  }
}
```
- 페이징 구현 예시  
  1. 최초 호출: `GET /ai/v2/sessions?limit=20`  
  2. 응답 `paging.cursor`가 존재하면 “더 보기” 클릭 시 `GET ...?cursor=<value>`  
  3. `has_more=false`일 때까지 반복

### 2.2 단일 세션 메타 `GET /ai/v2/sessions/:id`
- 자신이 만든 세션이 아니면 404.
- `message_count`를 추가로 주므로 목록에서 선택한 뒤 최신 상태를 다시 확인할 수 있다.

### 2.3 메시지 페이지네이션 `GET /ai/v2/sessions/:id/messages`
- 쿼리
  - `limit` (default 20, max 50)
  - `cursor`
  - `direction`: `'backward'`(기본) 또는 `'forward'`
- 응답
```json
{
  "session_id": 123,
  "owner_user_id": "blog-owner-123",
  "requester_user_id": "viewer-999",
  "messages": [
    {
      "id": 456,
      "role": "user",
      "content": "최근 인프라 글을 알려줘",
      "search_plan": {...},
      "retrieval_meta": null,
      "created_at": "2025-01-19T10:05:12.123Z"
    },
    {
      "id": 457,
      "role": "assistant",
      "content": "인프라 관련 최신 글은 ...",
      "search_plan": null,
      "retrieval_meta": {...},
      "created_at": "2025-01-19T10:05:20.000Z"
    }
  ],
  "paging": {
    "direction": "backward",
    "has_more": true,
    "next_cursor": "MjAyNS0wMS0xOVQxMDowNToxMi4xMjNa|456"
  }
}
```
- **무한 스크롤 구현 팁**
  1. 최신 메시지를 불러오려면 `direction=backward`, `cursor` 생략으로 시작. UI에서는 리스트 끝에 붙인다.
  2. 위로 스크롤하여 과거 메시지를 계속 불러오고 싶다면 응답의 `next_cursor`를 사용해 `GET ...?cursor=<value>&direction=backward`.
  3. 대화 중간으로 점프해 이후 메시지를 로드하려면 동일 cursor를 `direction=forward`로 호출하면 된다.
  4. 응답 메시지는 API에서 시간순으로 이미 정렬되어 있으므로 바로 렌더링하면 된다.

**무한 스크롤 의사 코드**
```ts
type PagingState = {
  prevCursor: string | null;
  nextCursor: string | null;
  hasMorePrev: boolean;
};

const state: PagingState = { prevCursor: null, nextCursor: null, hasMorePrev: true };

// 최신(아래쪽) 메시지 로드
const loadLatest = async () => {
  const params = new URLSearchParams({ limit: '20', direction: 'backward' });
  if (state.prevCursor) params.set('cursor', state.prevCursor);
  const res = await fetch(`/ai/v2/sessions/${sessionId}/messages?${params}`, { headers });
  const body = await res.json();
  renderPrepend(body.messages); // 위쪽에 추가
  state.prevCursor = body.paging?.next_cursor ?? null;
  state.hasMorePrev = Boolean(body.paging?.has_more);
};

// 사용자가 아래로 내려간 뒤 이후 메시지를 보고 싶을 때
const loadForward = async () => {
  if (!state.nextCursor) return;
  const params = new URLSearchParams({ limit: '20', direction: 'forward', cursor: state.nextCursor });
  const res = await fetch(`/ai/v2/sessions/${sessionId}/messages?${params}`, { headers });
  const body = await res.json();
  renderAppend(body.messages); // 아래쪽에 추가
  state.nextCursor = body.paging?.next_cursor ?? null;
};
```

### 2.4 PATCH / DELETE
- `PATCH /ai/v2/sessions/:id`  
  - Body: `{ "title": "...", "metadata": { ... } }` (둘 중 하나 이상 필수)
  - 성공 시 최신 메타를 반환.
- `DELETE /ai/v2/sessions/:id`  
  - `{ "session_id": 123, "deleted": true }`  
  - 세션/메시지/임베딩이 모두 cascade로 제거되므로 프론트에서 제거 후 새로고침 필요 없음.

---

## 3. 프론트엔드 구현 참고

### 3.1 ASK 스트림 핸들러 의사 코드
```ts
const sse = new EventSourcePolyfill('/ai/v2/ask', { headers: { Authorization: `Bearer ${token}` }, payload });
const state = { sessionId: null, chunks: [] };

sse.addEventListener('session', (evt) => {
  const data = JSON.parse(evt.data);
  state.sessionId = data.session_id;
  // 새 세션 ID를 저장해 다음 질문에 사용
});

sse.addEventListener('search_plan', (evt) => { ... });
sse.addEventListener('context', (evt) => { ... });
sse.addEventListener('answer', (evt) => {
  state.chunks.push(JSON.parse(evt.data));
  renderStreamingAnswer(state.chunks.join(''));
});

sse.addEventListener('session_saved', (evt) => {
  const data = JSON.parse(evt.data);
  showToast(data.cached ? '기존 답변을 재사용했어요.' : '대화가 저장되었습니다.');
});

sse.addEventListener('session_error', (evt) => {
  console.warn('세션 저장 실패', evt.data);
});

sse.onerror = () => {
  sse.close();
};
```

### 3.2 대화 목록/상세 UI 시나리오
1. **좌측 패널**: `/ai/v2/sessions?limit=20`으로 최근 대화 조회 → 커서 기반 “더 보기” 버튼.
2. **메시지 영역**: 세션을 선택하면 `GET /ai/v2/sessions/:id/messages`로 최신 메시지 불러오기 → `direction=backward`.
3. **무한 스크롤**: 맨 위로 스크롤되면 `cursor=previous.next_cursor`로 과거 메시지 로드.
4. **실시간 갱신**: SSE에서 받은 user/assistant 메시지를 메모리에 쌓고, 스트림 종료 후 `session_saved` 이벤트가 오면 REST API 결과와 동기화 가능.

### 3.3 세션 ID 전파
- 새 ASK 요청 → 응답 헤더 `session-id`와 `event: session`을 받으면, 프론트의 현재 대화 객체에 그 ID를 기록한다.
- 이후 폼 전송 시 `session_id`만 바디에 넣어서 이어서 질문할 수 있다.
- 다른 블로그로 이동하면 기존 세션 ID를 버리고 `user_id`를 새 값으로 넣어 다시 질문하면 된다(서버가 다른 owner와 세션을 매칭하지 않도록 검증함).

---

## 4. 오류 및 예외 처리

### 4.1 주요 SSE 이벤트 & UI 매핑

| 이벤트 | 예시 payload | 권장 UI 처리 |
|--------|--------------|--------------|
| `session` | `{ session_id, owner_user_id, requester_user_id }` | 새 세션 카드 추가, 현재 대화 헤더 업데이트 |
| `search_plan` | `{ mode: 'rag', ... }` | 디버그 패널, “검색 계획 준비 중…” 표시 |
| `rewrite` / `keywords` | `["재작성1", ...]` / `["키워드1", ...]` | 검색 과정 시각화(선택 사항) |
| `search_result` / `hybrid_result` | `[ { postId, postTitle }, ... ]` | 참고 컨텍스트 목록 표시 |
| `search_result_meta` / `hybrid_result_meta` | 추가 메타 정보 | 고급 모드 또는 디버그 뷰 |
| `exist_in_post_status` | `true/false` | “관련 글을 찾음/찾지 못함” 안내 뱃지 |
| `context` | `[ { postId, postTitle }, ... ]` | UI 우측 “참조 글 목록” 섹션 |
| `answer` | `"…LLM 청크…"` | 채팅 말풍선 실시간 갱신 |
| `session_saved` | `{ session_id, cached }` | 저장 완료/캐시 재사용 토스트, 상태 뱃지 |
| `session_error` | `{ reason }` | 오류 토스트, 재시도 버튼 노출 |
| `error` | `{ message }` | 스트림 종료 + 에러 메시지 |

### 4.2 오류 대응 요약

| 상황 | 응답/이벤트 | 대응 방법 |
|------|-------------|-----------|
| `session_id`가 유효하지 않음 | 400 + `{ message: 'Invalid session_id' }` | 프론트 세션 상태 초기화, 새 세션 생성 |
| 세션 owner 불일치 | 409 + `{ message: 'Session owner mismatch' }` | 다른 블로그로 전환 후 새 세션 시작 |
| 세션 접근 권한 없음 | 404 (`존재하지 않는다고 응답`) | 리스트를 다시 로드해 실제로 존재하는지 확인 |
| 포스트가 삭제/비공개 | SSE `event: error` + `session_error(reason=post_not_found/forbidden_post)` | 사용자에게 안내 후 대화 중단 |
| 저장 실패 | SSE `event: session_error` + reason | 로그/토스트로 사용자에게 “대화 저장에 실패했습니다” 알림 |
| LLM 오류/스트림 예외 | SSE `event: error` + `session_error(reason=llm_error/stream_error)` | 스트림 종료 후 재시도 UI |

---

이 가이드를 토대로 세션 기반 ASK UX를 구현하면, 신규 세션 생성에서 히스토리 로딩까지 백엔드와 일관된 동작을 보장할 수 있다. 추가 질문은 `docs/history-tasks/ASK_SESSION_MANAGEMENT` 시리즈나 최근 커밋을 참고한다.
