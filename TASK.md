## 중복 질문 판별 개선 계획
- 기존 ask_message_embedding은 단지 이본 질문의 벡터 값만 저장하므로 현재 프로젝트에서 작동중인 맥락 주입 부분에서 불일치가 가능함 
- 최근 2턴(사용자 질문)을 다 불러와 이번 질문과 합쳐 하나의 텍스트 블록으로 만든다. 예: `[Q-2]\n[Q-1]\n[Q-now]`.
- 없을 시 현재 질문만 저장
- 프롬프트에 주입하는 히스토리도 2턴이므로 캐시 비교 기준과 완전히 일치해 follow-up 질문 반복 시 캐시 정확도가 올라간다.
- 임베딩은 질문당 1회만 추가로 수행되므로 비용 증가는 미미하며, 길이가 길 경우 앞 턴을 줄이는 로직을 헬퍼에서 처리한다.

### 말투 ID 독립 컬럼 및 마이그레이션 계획
1. **DB 스키마 변경**: 중복 질문 판별 전용임을 명시하기 위해 `ask_message_embedding`을 `ask_question_cache`(또는 `ask_duplicate_embedding`)으로 리네임한다. 리네임 후 `speech_tone_id integer NOT NULL DEFAULT -1` 컬럼을 추가하고, 기존 레코드는 tone 정보가 없어 재사용 가치가 낮으므로 컬럼 추가 직후 `TRUNCATE` 또는 `DELETE`로 전량 삭제한다.
2. **엔티티/레포지토리 업데이트**: `ask-message-embedding.repository.ts`에서 `MessageEmbedding` 타입과 `upsertEmbedding`/`findSimilarEmbeddings` 결과에 `speechToneId` 필드를 노출한다.
3. **persistConversation 수정**: `session-history.service.ts`에서 `persistConversation` 호출 시 `speechTone` 파라미터를 새로 받아, 메시지 레포지토리에는 아무 변화 없이 `embeddingRepository.upsertEmbedding`에만 전달한다.
4. **캐시 비교 및 재작성 로직**: `findCachedAnswer`가 `speechToneId`를 반환하도록 수정하고, `qa.service.ts`/`qa.v2.service.ts`에서 tone ID 비교 결과에 따라 캐시 재생 또는 tone 재작성 분기를 처리한다.
5. **백필 전략(옵션)**: 추가 데이터를 이관하고 싶다면 별도 배치를 설계해 `speech_tone_id`를 채울 수 있지만, 초기에는 기본값 `-1`을 tone 불명 값으로 삼고 rewrite 플로우를 따른다.
6. **명명 개선 검토**: 테이블 리네임과 컬럼 추가는 같은 마이그레이션에서 처리하고, 관련 코드/SQL 명칭도 일괄 업데이트한다.

## 캐시 응답 말투 정합성 계획
1. **목표**: 캐시에서 꺼낸 답변의 말투가 API 요청 값과 일치하면 즉시 재사용하고, 불일치하면 동일 답변을 tone 전용 LLM으로 재작성한 뒤 전달한다.
2. **tone 검증 순서**
   - (a) `findCachedAnswer`가 반환한 후보 배열(유사도 기준 정렬)을 순회하며 `speechToneId === 요청 값`인 항목을 찾는다.
   - (b) 같은 ID가 있는 경우 해당 후보를 즉시 재생하고, tone 재작성은 생략한다.
   - (c) 같은 ID가 하나도 없으면 유사도 1순위 후보를 선택해 `replace-tone.service.ts`에 전달하고, tone만 바꾼 결과를 사용자에게 전송한다. (threshold 미달이면 기존처럼 새 LLM 답변 생성)
3. **replace-tone.service.ts**
   - 시그니처: `rewriteTone(answer: string, opts: { speechToneId: number; speechTonePrompt: string; llm?: LlmOverride })`.
   - 프롬프트 구성
     - System: "너는 편집자다. 아래 콘텐츠의 의미, 사실, 구조를 훼손하지 말고, 요청된 말투 지시만 반영해 다시 작성해."
     - User: ```tone 지시: ${speechTonePrompt}
원문: ${answer}```
   - 모델/프로바이더는 운영 편의를 위해 기존 QA 파이프라인과 동일한 `generate` 래퍼를 그대로 사용한다(즉, Ask 요청에서 선택된 LLM 설정을 재사용). temperature는 0~0.2, max_tokens는 원문 길이와 비슷하게 맞춘다.
   - tone 재작성 결과가 비어 있거나 원문과 지나치게 다르면 실패로 간주하고 캐시를 포기한 뒤 RAG/LLM 경로로 폴백한다.
4. **서비스 연동** (`qa.service.ts`, `qa.v2.service.ts`)
   - `findCachedAnswer`가 tone ID와 함께 후보 배열을 돌려줄 수 있도록 확장하거나, tone별 우선순위를 반환한다.
   - tone 동일 후보가 있으면 기존 `replayCachedAnswer`를 실행한다.
   - tone 불일치만 있는 경우엔 `rewriteTone` 호출 후, SSE `answer` 이벤트와 `persistConversation`에 재작성된 텍스트를 사용하고 `speech_tone_id`를 목표 값으로 저장한다.
5. **운영 고려사항**: tone ID의 기본값을 `-1`(unknown)으로 두고, 이 값은 tone 동일 후보 검색에서 매칭되지 않도록 처리한다. 즉, 모든 후보가 `-1`이면 top-1 rewrite 대상으로만 사용된다.

### 구현 우선순위 및 단계
1. **중복 질문 판별 개선**: 히스토리 2턴을 합친 텍스트 블록 기반으로 임베딩을 저장하고 캐시 비교에 활용한다. (상단 계획을 먼저 적용)
2. **말투 ID 컬럼 추가**: 위 마이그레이션 계획대로 DB 및 레포지토리를 확장해 tone 정보가 영속되도록 한다.
3. **말투 조정 기능 도입**: `replace-tone.service.ts` 구현과 `replayCachedAnswer` 통합으로 캐시 히트 시 tone 검증/재작성 플로우를 완성한다.
4. **후속 최적화**: tone 컬럼이 채워진 이후에는 tone 일치 여부를 먼저 확인해 tone 분석/재작성 호출을 최소화한다.

## 상세 구현 설계
1. **마이그레이션**
   - 새 SQL 파일(예: `docs/migrations/2025-XX-ask-question-cache-tone.sql`)을 작성하여 테이블 리네임(`ALTER TABLE ask_message_embedding RENAME TO ask_question_cache;`) → 컬럼 추가(`ADD COLUMN speech_tone_id integer NOT NULL DEFAULT -1;`) → 기존 데이터 삭제(`TRUNCATE ask_question_cache;`)를 순차 진행한다.
   - 필요한 경우 `speech_tone_id`에 인덱스(`CREATE INDEX ... ON ask_question_cache(owner_user_id, requester_user_id, speech_tone_id)`)를 추가해 tone 별 검색을 빠르게 한다.
2. **레포지토리 계층**
   - `ask-message-embedding.repository.ts` (리네임 후 `ask-question-cache.repository.ts` 고려)
     - `MessageEmbedding`/`SimilarMessage` 인터페이스에 `speechToneId: number` 추가. 기본값 `-1`은 별도 상수로 관리한다.
     - `upsertEmbedding` INSERT/UPDATE 문에 `speech_tone_id` 컬럼을 포함하고, 매개변수로 tone ID를 받는다.
     - `findSimilarEmbeddings` SELECT에 `speech_tone_id AS "speechToneId"`를 추가하고, 반환 타입에 포함.
   - `session-history.service.ts`
     - `persistConversation` 파라미터에 `speechTone?: number`를 추가하여 assistant 톤을 전달.
     - `embeddingRepository.upsertEmbedding` 호출 시 새 tone 값을 전달.
     - `findCachedAnswer`가 `speechToneId`를 함께 포함한 후보 배열을 리턴하도록 수정 (ex: `{ answer, searchPlan, retrievalMeta, similarity, speechToneId }`).
3. **서비스 계층 (QA)**
   - `qa.service.ts` / `qa.v2.service.ts`
     - 캐시 조회 결과를 tone별로 분류: `const matched = candidates.find(c => c.speechToneId === speechTone)`.
     - `matched`가 있으면 기존 `replayCachedAnswer(matched)` 실행.
     - 없고 후보 배열이 존재하면 `const primary = candidates[0];` 로 선정 후 `replaceTone.rewriteTone(primary.answer, speechTonePrompt)` 호출.
     - 재작성 결과 텍스트를 SSE `answer` 이벤트로 흘려보내고, `persistConversation`에 `speechTone` 값을 명시해 저장.
     - 재작성 여부를 `DebugLogger`에 남기고, 실패 시 기존 RAG/LLM 경로로 폴백한다.
4. **replace-tone.service.ts**
   - 최종 시그니처: `export const rewriteTone = async (
        answer: string,
        opts: { speechToneId: number; speechTonePrompt: string; llm?: LlmOverride }
      ): Promise<string>`.
   - 내부에서 `generate`를 호출하며, 시스템 프롬프트에 "다음 답변의 내용은 유지하고 tone만 아래 지시에 맞춰라" 구조를 사용한다.
   - 응답이 비거나 너무 짧으면 실패로 간주하고 오류를 throw.
5. **SSE / 이벤트**
   - tone 재작성 시에도 `search_plan`, `context` 이벤트는 캐시된 값 그대로 재생하고 `answer` 이벤트에만 수정된 텍스트를 전송.
   - `session_saved` 이벤트에 `cached: true`와 `tone_rewritten: true` (추가 속성) 등을 포함해 프론트에서 구분할 수 있도록 한다.
6. **테스트 전략**
   - `session-history.service` 단위 테스트: tone ID가 upsert 및 조회되는지 검증.
   - QA 서비스 통합 테스트: (1) 동일 tone 캐시 재생, (2) tone 불일치로 rewrite, (3) rewrite 실패 시 LLM 재호출 폴백.
   - 마이그레이션 테스트: 로컬 DB에서 `speech_tone_id integer NOT NULL DEFAULT -1`가 정확히 적용되는지 확인.

## 커밋 단위 구현 계획
1. **마이그레이션 + DB 명명 정리**
   - `docs/migrations/2025-XX-ask-question-cache-tone.sql` 추가: 테이블 리네임 → 컬럼 추가 → TRUNCATE → 인덱스 생성.
   - `README.md` 등 마이그레이션 가이드에 새 스크립트 실행 방법 추가.

2. **레포지토리 계층 업데이트**
   - (선택) `ask-message-embedding.repository.ts` 파일명을 `ask-question-cache.repository.ts`로 변경하고 import 경로 수정.
   - 인터페이스/쿼리에 `speechToneId` 반영, upsert 파라미터에 tone ID 추가.

3. **세션 히스토리 서비스 수정**
   - `persistConversation` 시그니처에 `speechTone?: number` 추가.
   - `embeddingRepository.upsertEmbedding` 호출부에 tone 전달.
   - `findCachedAnswer` 반환 타입을 tone 정보 포함 배열로 변경.

4. **QA 서비스 캐시 로직 개편**
   - `qa.service.ts`/`qa.v2.service.ts`에서 tone 일치 후보 우선 사용, 불일치 시 `replaceTone` 경로로 분기.
   - SSE 이벤트/`persistConversation`에 재작성 결과 및 tone ID 반영.
   - DebugLogger 로깅 추가.

5. **replace-tone.service.ts 신규 추가**
   - `rewriteTone` 함수 구현, 프롬프트 템플릿/에러 처리를 포함.
   - 필요 시 `qa.prompts.ts`에 tone 전용 프롬프트 자산 추가.

6. **테스트/검증**
   - `session-history` 단위 테스트, QA 통합 테스트 보강.
   - 마이그레이션 스크립트 dry-run 결과 공유 및 README 업데이트.
