# ASK 중복 질문 캐시 & Tone Rewrite 회고

이번 작업은 “중복 질문 캐시를 더 똑똑하게 만들고, tone 정합성을 지키면서도 비용을 줄이자”라는 목표로 진행했다. 아래 정리는 과장 없이 우리가 실제로 마주친 문제와 해결 과정, 그리고 그 결과다.

## 왜 손봤나
- **Follow-up 질문 품질**: 프롬프트에는 항상 직전 2턴이 붙지만, 캐시는 단일 질문 벡터만 저장했다. follow-up 질문이 들어오면 캐시가 엇나가거나, 유사도 비교 자체가 어렵다.
- **Tone 불일치**: 캐시에서 꺼낸 답변의 말투가 요청 값과 다르면 사용자 경험이 깨진다. tone 정보를 캐시에 같이 저장하지 않으면, 결국 새 LLM 호출을 해야 했다.
- **콘텐츠 정합성**: 사용자가 글을 수정/삭제해 임베딩이 새로 생성될 때, 예전 중복 질문 캐시가 남아 있으면 최신 본문과 어긋난 답변이 튀어나온다.

## 어떻게 풀었나

### 1. 캐시 스키마 + tone 메타
- `ask_message_embedding`을 `ask_question_cache`로 리네임하고, `speech_tone_id integer NOT NULL DEFAULT -1`을 추가했다. (파일: `docs/migrations/2025-03-ask-question-cache-tone.sql`)
- 마이그레이션 직후 `TRUNCATE`로 tone 정보가 없는 캐시를 비웠다. 덕분에 tone-aware 로직과 충돌하는 레코드가 남지 않았다.

### 2. 히스토리 2턴을 합쳐 임베딩
- `buildDuplicateQuestionBlock`(`session-history.service.ts:22`)이 `[Q-2]`, `[Q-1]`, `[Q-now]` 블록을 만들어준다. 길이가 길면 앞선 턴부터 자른다.
- `qa.service.ts:172`, `qa.v2.service.ts:154`에서 `[현재 질문, 중복 질문 블록]`을 동시에 임베딩한다.  
  - 첫 번째 벡터 → RAG 검색용  
  - 두 번째 벡터 → 캐시 저장/조회용
- `persistConversation`(`session-history.service.ts:68`)이 answer tone과 중복 질문 벡터를 함께 `ask_question_cache`에 upsert한다.

### 3. tone-aware 캐시 조회
- `findCachedAnswer`(`session-history.service.ts:146`)가 owner, post, category 조건에 맞는 후보를 tone ID와 함께 돌려준다. `requester_user_id` 필터를 없애 동일 글의 관리자는 여러 상담 채널/요청자 간에도 캐시를 재활용할 수 있다.
- `selectToneAwareCacheCandidate`(`session-history.service.ts:36`)가 요청 tone과 동일한 후보를 고르고, 없으면 top-1 후보를 rewrite 대상으로 지정한다.
- `qa.service.ts:192`, `qa.v2.service.ts:175`에서 tone이 맞는 캐시는 그대로 재생하고, tone이 다르면 rewrite 경로로 분기한다.

### 4. `replace-tone.service.ts` 디테일
- 기존 `generate` 래퍼를 그대로 사용하면서 system/user 프롬프트를 tone 교체에 맞춰 고정했다.
- **Ask v2**: 캐시 → tone mismatch → `rewriteTone`만 호출하므로 LLM 호출 수가 2 → 1로 줄어든다.  
  **Ask v1**: LLM 호출 수는 동일하지만 tone 재작성은 원문만 넣으니 입력 토큰이 줄어 비용 절감이 된다.
- tone 재작성 실패 시에는 로그를 남기고 RAG 경로로 폴백한다. 성공하면 SSE `answer` 이벤트와 `persistConversation`에 tone ID를 저장한다.

### 5. 임베딩 워커에서 정합성 보장
- 포스트 임베딩 작업(수정/삭제 포함)이 끝나면 `queue-consumer.ts`가 `deleteEmbeddingsByOwner`(`ask-question-cache.repository.ts:166`)를 호출한다.
- 그 사용자에 대한 중복 질문 캐시가 전부 지워져서, 새로운 임베딩과 캐시가 항상 같은 시점을 바라보게 된다. 이 정합성 덕분에 “본문은 최신인데 캐시는 옛날 기록” 같은 상황을 확실하게 막았다.

## 운영 & 디버깅 팁
- `speech_tone_id = -1`은 tone 미확인 상태로 간주한다. rewrite 한 번만 성공하면 tone이 채워져 이후에는 재작성 없이 캐시를 재생할 수 있다.
- `DEBUG_CHANNELS=qa` + `DEBUG_EXCLUDE_TYPES` 조합으로 `debug.qa.cache_candidates` / `debug.qa.v2.cache_candidates` 로그만 추려보면 tone 매칭 상태를 바로 확인할 수 있다.
- 특정 사용자의 중복 질문 캐시를 비우고 싶으면 `deleteEmbeddingsByOwner`를 실행하면 된다. 워커에서 이미 자동으로 호출하지만, 필요 시 수동으로도 가능하다.

## 결과
- follow-up 질문에서도 동일한 히스토리를 기준으로 캐시가 비교되니, 중복 질문 탐지가 더 정확해졌다.
- tone mismatch 상황에서도 `rewriteTone`만 호출하면 되기 때문에, Ask v2에서는 LLM 호출을 1번으로 줄였고 v1에서도 입력 토큰이 줄어 비용이 내려갔다.
- 임베딩 워커 단계에서 캐시를 정리하니, 콘텐츠 정합성을 걱정할 일이 없어졌다. “최신 글과 tone까지 맞춘 캐시”라는 목표를 과장 없이 달성했다.
