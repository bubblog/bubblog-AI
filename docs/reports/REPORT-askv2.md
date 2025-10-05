# 보고서: /ai/v2/ask 구현 내역과 구조

## 1) 개요
- 목적: v1의 고정형 RAG 흐름을 개선하기 위해, 사용자의 질문을 LLM이 “검색 계획(JSON)”으로 구조화 → 서버가 안전한 시맨틱 SQL 검색 수행 → v1과 동일한 방식으로 최종 답변을 SSE로 스트리밍하는 v2 파이프라인을 추가했습니다.
- 상태: v1은 수정하지 않고 유지. v2 엔드포인트 `POST /ai/v2/ask`(SSE) 신규 추가 및 전체 흐름 구현 완료.

## 2) v1의 주요 문제점(한계)
- 고정 파라미터 검색: 임계치(0.2), LIMIT(5)가 고정되어 질문 의도(기간/정렬/가중치/갯수 등) 반영이 어려움.
- 시간/정렬 표현 미흡: “최근 글/9월 글/지난주” 등 자연어 시간 요구를 반영할 수 없음.
- 컨텍스트 제어 부족: LLM 입력 컨텍스트의 개수/범위를 질문 의도나 비용/토큰 예산에 맞춰 유연하게 조절하기 어려움.
- 관측성 부족: 어떤 기준/전략으로 검색되었는지(계획/파라미터)를 클라이언트에서 파악하기 어려움.
- 보안/안전 제약: 프롬프트/검색 로직이 단순해, 미래에 복잡한 동적 쿼리로 확장 시 안전한 경계(화이트리스트/스키마 강제)가 필요.

![alt text](../structureDiagram/askV1-structure.png)

## 3) v2의 도입/해결 방안과 가능해진 것
- LLM 검색 계획(JSON) 도입
  - OpenAI Responses API + JSON Schema 강제 → LLM이 오직 스키마에 맞는 JSON만 출력.
  - 계획 항목: `mode`(rag/post), `top_k`, `threshold`, `weights{chunk,title}`, `filters{user_id, category_ids?, post_id?, time?}`, `sort`, `limit`.
- 시간/정렬 의도 반영
  - 자연어 시간(최근/이번 달/지난주/9월/작년 등)을 `filters.time`에 구조화.
  - 서버는 KST 기준 절대 기간으로 표준화(from/to) 후 안전 SQL에 반영.
  - 최신순/오래된순 정렬(`sort`) 지원.
- 안전한 서버 표준화/실행
  - Zod로 계획 검증 + 범위 강제(top_k 1..10, limit 1..20, threshold 0..1, weights 합=1).
  - SQL은 화이트리스트 템플릿 + 파라미터 바인딩으로만 구성(문자열 결합 금지).
- 관측성 강화
  - SSE 메타 이벤트(`search_plan`, `search_result`)를 추가해, 검색 계획과 결과 요약을 클라이언트에 투명하게 제공.
- 컨텍스트 최적화
  - 청크 검색 후보(top_k)를 넓게 가져온 뒤, 포스트 단위 중복 제거 + `limit`개까지만 컨텍스트/노출로 사용(토큰/비용 관리).
- 폴백 안전성
  - 계획 생성 실패 시 v1 RAG 경로로 자동 폴백하여 기능 연속성 보장.
![alt text](../structureDiagram/askV2-structure.png)
## 4) v2 구조(파일과 역할)
- 라우팅/컨트롤러
  - `src/routes/ai.v2.routes.ts`: `/ai/v2/ask` SSE 라우트.
  - `src/controllers/ai.v2.controller.ts`: SSE 헤더 설정, 서비스 호출/파이프.
  - `src/app.ts`: `/ai/v2` 마운트.
- 플래너 LLM & 타입
  - `src/types/ai.v2.types.ts`: v2 요청/검색 계획 Zod 스키마.
  - `src/prompts/qa.v2.prompts.ts`: 검색 계획 프롬프트/JSON 스키마.
  - `src/services/search-plan.service.ts`: Responses API 호출 → 계획 JSON 검증/정규화.
- 시간 표준화
  - `src/utils/time.ts`: KST 기준 상대/월/분기/연도 → 절대기간 변환.
- 시맨틱 서치
  - `src/services/semantic-search.service.ts`: 질문 임베딩 생성 → 동적 저장소 호출.
  - `src/repositories/post.repository.ts`: `findSimilarChunksV2`(가중치/임계치/기간/정렬/topK 파라미터 반영).
- 오케스트레이션
  - `src/services/qa.v2.service.ts`: `search_plan`→`search_result` 발행, v1 프롬프트 재사용으로 최종 LLM 스트림 중계.

## 5) v2 요청→응답 흐름
1) 클라이언트: `POST /ai/v2/ask` (JWT 필요)
2) 컨트롤러: SSE 헤더 설정 → `answerStreamV2` 호출
3) post 모드(post_id 존재): 소유자 검증 → 계획/결과 이벤트 발행 → 본문 컨텍스트로 메시지 구성 → 답변 스트림
4) rag 모드: 플래너 LLM으로 계획 생성 → Zod 검증/시간 표준화 → `search_plan` 이벤트 발행 → 시맨틱 서치 실행 → `search_result`/`exist_in_post_status`/`context` 발행 → RAG 프롬프트 구성 → 답변 스트림
5) 공통: `src/llm` 레이어를 통해 `answer` 청크 스트리밍, 종료 시 `end` 이벤트

SSE 이벤트 순서
- `search_plan` → `search_result` → `exist_in_post_status` → `context` → `answer`* → `end`
- 오류 시: `error`

## 6) 모델/설정
- 기본 LLM: `openai/gpt-5-mini`(요청 `llm` 또는 `CHAT_MODEL`로 변경 가능)
- 임베딩: `text-embedding-3-small`
- Gemini: 응답 스트림은 지원(계획 LLM은 현재 OpenAI 사용)

## 7) 보안/안전
- 계획 출력은 JSON Schema로 제한, 서버에서 Zod 검증 및 값 범위 강제.
- SQL은 파라미터 바인딩/화이트리스트 템플릿만 사용.
- post 모드에서 소유권 체크.
- SSE에는 민감정보 제외(제목/ID 등만 노출).

## 8) 현재 동작과 향후 확장
- 현재
  - `top_k`: 청크 단위 후보 개수(리콜 폭)로 SQL LIMIT 적용(v1과 동일).
  - `limit`: 현재는 미적용(v1과 동일 동작 유지). 컨텍스트는 청크 Top-K를 그대로 사용하며, 포스트 단위 중복 제거도 하지 않음.
  - `sort`: 유사도 우선 + 최신순/오래된순 보조 정렬.
- 향후
  - `limit` 적용을 재도입하여 컨텍스트 길이/비용 최적화(옵션화 가능).
  - 포스트별 상위 N청크 추출(윈도우 함수) 설계로 깊이/다양성 균형.
  - `search_sql` 이벤트(템플릿 ID + 파라미터 프리뷰)로 관측성 강화.
  - 계획 LLM의 프로바이더 확장(Gemini) 및 프롬프트 튜닝 고도화.

## 9) 사용 예시
- 요청 바디 예시
```
{
  "question": "9월 글 2개만 보여줘",
  "user_id": "<uid>",
  "speech_tone": -1,
  "llm": { "provider": "openai", "model": "gpt-5-mini" }
}
```
- 기대 SSE 순서: `search_plan` → `search_result` → `exist_in_post_status` → `context` → `answer*` → `end`

