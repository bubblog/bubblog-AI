# v2 설계 및 작업 계획 (LLM 주도 SQL 기반 시맨틱 서치 → 응답 스트리밍)

## 목표
- v1 API/흐름은 그대로 유지.
- v2에서 질의를 LLM이 “검색 계획(계획 JSON)”으로 변환 → 서버가 안전하게 실행하여 컨텍스트 확보 → 확보한 컨텍스트와 함께 LLM에 넘겨 최종 답변을 SSE로 스트리밍.

## 적합성 평가 (요약)
- 장점
  - LLM이 질문 의도를 기반으로 동적 필터/가중치/Top-K/Threshold를 튜닝한 “검색 계획”을 생산하여 검색 적합도를 끌어올릴 수 있음.
  - DB 스키마/비즈니스 제약을 반영해 검색 전략을 바꾸기 쉬움(프롬프트/제약 업데이트로 최적화 가능).
- 리스크 및 보완
  - “LLM이 직접 SQL 문자열”은 주입/스키마 일탈 위험. 안전하게 “계획(JSON)”을 생성하게 하고, 서버가 화이트리스트 템플릿/파라미터 바인딩으로 SQL을 구성하는 방식 권장.
  - 벡터 연산 상 LLM은 임베딩을 생성할 수 없으므로, 서버가 질문 임베딩을 계산하여 파라미터로 주입해야 함.
  - 실패/부적합 시 v1 RAG 경로로 폴백 필요.

결론: “LLM → 검색 계획(JSON) → 서버가 안전 SQL 구성/실행 → 결과 컨텍스트로 최종 LLM”의 변형 설계가 적합하며 안전/유지보수에도 유리.

## v2 전체 흐름
1) 클라이언트가 `POST /ai/v2/ask`로 질문 전송(SSE 응답).
2) 서버가 LLM에 “검색 계획” 생성을 요청(계획 JSON; SQL 문자열 생성은 비권장, 옵션으로 지원).
3) 서버가 계획(JSON)을 검증/정규화 후 파라미터 바인딩으로 안전 SQL 실행(벡터 임베딩은 서버가 생성).
4) 검색 결과(문맥) 메타 이벤트 송신(`search_plan`, `search_result`).
5) 기존 v1과 동일한 형식의 최종 LLM 호출을 수행하고 `answer`를 스트리밍.
6) 종료 시 `end: [DONE]` 송신.

## API 설계
- Route: `POST /ai/v2/ask` (SSE)
- Auth: 기존 `authMiddleware` 재사용
- Request Body (제안)
  - `question: string`
  - `user_id: string`
  - `category_id?: number`
  - `post_id?: number` (지정 시 해당 글 컨텍스트 중심)
  - `speech_tone?: number`
  - `llm?: { provider?: 'openai'|'gemini', model?: string, options?: { temperature?: number, top_p?: number, max_output_tokens?: number } }`
- SSE 이벤트(순서 권장)
  - `event: search_plan` / `data: { ...계획JSON }`
  - `event: search_sql` / `data: { templateId, paramsPreview }` (SQL 템플릿 경로 선택 시, 민감정보 제외 프리뷰)
  - `event: search_result` / `data: [{ postId, postTitle }]`
  - `event: exist_in_post_status` / `data: true|false` (v1과 동일)
  - `event: context` / `data: [{ postId, postTitle }]` (v1과 동일)
  - `event: answer` (여러 번)
  - `event: end` / `data: [DONE]`
  - `event: error` (오류 시)

## LLM “검색 계획” 출력 스키마(권장)
```json
{
  "mode": "rag",                  // "rag" | "post"
  "top_k": 5,                      // 1~20 범위 권장
  "threshold": 0.2,                // 0.0~1.0, 유사도 하한
  "weights": { "chunk": 0.7, "title": 0.3 },
  "filters": {
    "user_id": "<server-provided>",
    "category_ids": [7],           // 필요 시
    "post_id": 123,                // mode=post 시
    "time": {                      // 시간/날짜 필터(선택)
      "type": "relative",         // "relative" | "absolute" | "month" | "year" | "quarter"
      "unit": "day",              // relative: "day" | "week" | "month" | "year"
      "value": 30                  // relative: 정수(양수)
      // absolute: { from: ISO8601, to: ISO8601 }
      // month: { month: 1..12, year?: number }
      // year: { year: number }
      // quarter: { quarter: 1..4, year?: number }
    }
  },
  "sort": "created_at_desc",       // "created_at_desc" | "created_at_asc"
  "limit": 5                       // 결과 행 상한(서버 상한 적용)
}
```
- 서버에서 Zod로 검증 후 기본값/상한선 적용(top_k max 10 등), 불일치 시 안전 폴백값 적용.
- SQL 템플릿은 서버가 선택/생성하며, 파라미터는 모두 바인딩 처리.

### 시간/날짜 필터 처리 규칙
- 서버 표준화 단계에서만 절대 기간으로 변환(Asia/Seoul 기준 권장):
  - relative: 현재 시각 기준으로 from/to 계산(예: 최근 30일)
  - month: 연도 미지정 시 현재 연도 사용(예: “9월” → 올해 9월 1일 00:00:00 ~ 9월 말 23:59:59)
  - quarter/year: 분기·연도 경계 계산
- 검증 실패·모호 값: 날짜 필터 제외 혹은 기본 30일 적용 후 로그 남기고 폴백
- 모든 상수값은 서버에서 범위 강제(limit<=20, top_k<=10, threshold 0..1, weights 합=1)

## SQL 실행(안전 구성)
- 벡터 임베딩: 서버가 `createEmbeddings([question])`로 생성.
- 화이트리스트 템플릿(예시)
  - 공통: 사용자/카테고리/소유권 필터를 CTE에서 먼저 적용.
  - 스코어링: `(w_chunk * (1 - (pc.embedding <=> $embed))) + (w_title * (1 - (pte.embedding <=> $embed))) AS score`
  - 임계치: `WHERE (1 - (pc.embedding <=> $embed)) > $threshold`
  - 날짜 필터: `AND bp.created_at BETWEEN $from AND $to` (표준화된 절대 기간 사용)
  - 정렬/상한: `ORDER BY score DESC` + 옵션 정렬(`created_at_desc|asc`) 병합, `LIMIT $limit`
- 모든 동적 값은 파라미터로 바인딩하고, 가중치/상한 등은 서버에서 범위 제한.

## 최종 LLM 호출(응답 생성)
- v1의 `generate` 재사용(프로바이더/모델 동일 정책).
- 프롬프트: v1의 `qa.prompts`를 재사용하되, v2에서는 `search_result` 컨텍스트를 그대로 투입.
- v1과 동일한 `report_content_insufficient` 툴 전략 유지(필요 시).

## 디렉터리/컴포넌트 추가 계획
- `src/routes/ai.v2.routes.ts` — v2 라우터(`POST /ask`).
- `src/controllers/ai.v2.controller.ts` — SSE 헤더 설정, 서비스 호출/파이프.
- `src/services/search-plan.service.ts` — LLM에 검색 계획 요청 및 스키마 검증.
- `src/services/semantic-search.service.ts` — 계획(JSON)→SQL 템플릿 매핑 및 안전 실행.
- `src/services/qa.v2.service.ts` — 전체 orchestrator: 계획 생성→검색→컨텍스트 이벤트→최종 LLM 스트림.
- `src/prompts/qa.v2.prompts.ts` — 검색 계획 LLM 프롬프트(스키마/제약 포함).
- `src/types/ai.v2.types.ts` — 요청/계획/응답 타입/Zod 스키마.
- `src/routes/ai.routes.ts`는 그대로, `app.ts`에 `/ai/v2` 라우트 추가.

## 프롬프트 가이드(검색 계획용, 요지)
- 역할: “블로그 시맨틱 검색 플래너”.
- 입력: 질문, 사용자 메타(user_id/category_id/post_id), 스키마/제약 요약, 기본값.
- 출력: 상기 계획 JSON 스키마만 생성(그 외 텍스트 금지).
- 제약: 값 범위(Top-K, threshold, weights 합=1), 허용된 필드만.
- 실패 시: 기본값으로 귀결되는 최소 계획을 출력하도록 유도.
- 시간/날짜 처리 지침:
  - 시스템 메시지에 현재 날짜/시간과 타임존(예: Asia/Seoul)을 제공
  - “최근/이번 달/지난주/9월/작년 9월” 등 자연어 시간을 위 스키마의 time 필드로 구조화
  - 연도 미지정 시 현재 연도 가정, 모호하면 relative 30일로 유도

## 예시
- “최근 글 보여줘”
  - LLM 계획(JSON): `{ "mode": "rag", "top_k": 5, "threshold": 0.2, "weights": { "chunk": 0.7, "title": 0.3 }, "filters": { "user_id": "<server>", "time": { "type": "relative", "unit": "day", "value": 30 } }, "sort": "created_at_desc", "limit": 5 }`
  - 서버 표준화: `time → absolute { from: <30일 전 00:00+09:00>, to: <지금+09:00> }`, `limit=5`

- “9월 글 2개”
  - LLM 계획(JSON): `{ "mode": "rag", "top_k": 5, "threshold": 0.2, "weights": { "chunk": 0.7, "title": 0.3 }, "filters": { "user_id": "<server>", "time": { "type": "month", "month": 9 } }, "sort": "created_at_desc", "limit": 2 }`
  - 서버 표준화: `time → absolute { from: YYYY-09-01T00:00:00+09:00, to: YYYY-09-30T23:59:59+09:00 } (연도 미지정 시 올해)`, `limit=2`

## 폴백 전략
- 계획 JSON 검증 실패/LLM 오류 → v1 RAG 경로로 폴백.
- 검색 결과 0건 → v1과 동일하게 `exist_in_post_status=false` 전송 후, 부족 안내 규칙에 맞춰 답변 유도.

## 텔레메트리/비용
- `llm.request/llm.response` 로그 기존 그대로 사용.
- v2 전용 디버그 이벤트: `debug.plan.start`, `debug.plan.json`, `debug.plan.sql`, `debug.plan.result` 등.

## 마이그레이션/DB
- 추가 테이블 불필요(기존 `post_chunks`, `post_title_embeddings` 재사용).
- 필요 시 뷰/인덱스 최적화 검토: `post_chunks(post_id, embedding)`, `post_title_embeddings(post_id, embedding)`.

## 보안/안전장치
- LLM은 “계획 JSON”만 생성(기본). SQL은 서버가 템플릿/파라미터 바인딩으로 생성.
- 만약 SQL 문자열 모드가 필요하면: 템플릿 ID+파라미터만 허용하거나, 정규식/AST로 화이트리스트 검증 후 실행.
- SSE에 민감 값(user_id/token 등) 노출 금지.

## 단계별 작업(체크리스트)
1) 스켈레톤
   - [ ] 라우터/컨트롤러 v2 추가(`/ai/v2/ask`)
   - [ ] SSE 헤더/에러 핸들링 공통화
2) 검색 계획
   - [ ] `search-plan.service` + `qa.v2.prompts` + Zod 스키마
   - [ ] 계획 실패 시 v1 경로 폴백
3) 검색 실행
   - [ ] 임베딩 생성(질문)
   - [ ] 템플릿 기반 안전 SQL 실행 + 파라미터 바인딩
   - [ ] `search_plan`, `search_result` SSE 송신
4) 최종 응답 스트림
   - [ ] v1 `generate` 재사용하여 LLM 스트림
   - [ ] v1과 동일한 `answer`/`end`/`error` 이벤트 유지
5) 관측성/테스트
   - [ ] 디버그/비용 로그 연결
   - [ ] 단위 테스트: 계획 검증/템플릿 빌더/리포지토리
   - [ ] 통합 테스트: SSE 이벤트 순서/형식

## 수용 기준(AC)
- `/ai/v2/ask`가 SSE로 동작하고, `search_plan`→`search_result`→`answer` 순으로 이벤트가 수신된다.
- 계획 JSON이 범위를 벗어나거나 실패해도 서버는 안전 폴백으로 정상 응답을 스트리밍한다.
- SQL은 파라미터 바인딩으로만 구성되며, 화이트리스트 템플릿을 벗어난 질의가 실행되지 않는다.
- v1과 동일한 최종 응답 품질을 유지하거나 개선한다.

## 검색 계획 LLM 프롬프트(초안)

목표: LLM이 “검색 계획 JSON”만 출력하도록 강제하여 서버가 안전하게 SQL 템플릿을 선택·실행할 수 있도록 한다. 자연어 시간(최근/이번 달/지난주/9월/작년 9월 등)을 구조화하고, 정렬/상한/가중치/임계치 값 제약을 지키도록 한다.

입력 변수(서버가 주입)
- now_utc, now_kst: 현재 시간(ISO8601)
- timezone: 문자열(예: Asia/Seoul)
- user_id: 요청자의 사용자 ID
- category_id?: 선택, 존재 시 조상 기준 필터
- post_id?: 선택, 존재 시 mode=post 우선
- defaults: { top_k: 5, threshold: 0.2, weights: { chunk: 0.7, title: 0.3 }, sort: created_at_desc, limit: 5 }
- question: 사용자 질문 원문

출력 형식(반드시 엄수)
- 오직 하나의 JSON 객체만 출력. 추가 텍스트/주석/마크다운/설명 금지.
- 키/값은 스키마 내 필드만 사용. 불필요 필드 생성 금지.

스키마(재확인)
{
  "mode": "rag" | "post",
  "top_k": number,                 // 1..10
  "threshold": number,            // 0..1
  "weights": { "chunk": number, "title": number }, // 0..1, 합=1
  "filters": {
    "user_id": string,
    "category_ids"?: number[],     // 제공 시 우선 적용(카테고리 조상 ID)
    "post_id"?: number,            // mode=post 시 필수
    "time"?: {                     // 하나만 선택
      "type": "relative" | "absolute" | "month" | "year" | "quarter",
      // relative
      "unit"?: "day" | "week" | "month" | "year",
      "value"?: number,
      // absolute
      "from"?: string,             // ISO8601
      "to"?: string,               // ISO8601
      // month
      "month"?: number,            // 1..12, year 없으면 현재 연도 가정
      "year"?: number,
      // quarter
      "quarter"?: number           // 1..4, year 없으면 현재 연도 가정
    }
  },
  "sort": "created_at_desc" | "created_at_asc",
  "limit": number                  // 1..20
}

규칙(핵심)
- post_id가 존재하면 mode="post"를 사용하고 filters.post_id를 설정. 그렇지 않으면 mode="rag".
- category_id가 있으면 filters.category_ids에 포함(단일 ID여도 배열 사용 허용).
- 가중치 합은 1이 되도록 조정(기본 chunk 0.7, title 0.3). 범위를 넘을 경우 기본값 사용.
- top_k는 1..10, limit는 1..20, threshold는 0..1 범위로 제한. 미지정 시 기본값 사용.
- 시간 표현 해석:
  - “최근/요즘/최근 N개” → relative(단, “N개”는 limit=N으로 반영; 기간은 기본 30일 유지)
  - “최근 N일/주/달/년” → relative + { unit, value }
  - “이번 달/이번 주/올해/올해 9월” → month/year/quarter로 구조화
  - “9월”처럼 연도 미지정 → 현재 연도 가정
  - “지난주/지난달/작년” → relative 또는 해당 단위 기간으로 구조화
  - 모호하거나 충돌 시 time 생략(서버 기본 30일 적용 예상)
- 정렬: “최근/최신/새로운” 등은 created_at_desc. “오래된”은 created_at_asc.
- 질문에 “N개”가 있으면 limit=N 반영(상한 20).
- JSON 이외 어떤 텍스트도 출력하지 말 것.

시스템 프롬프트 템플릿
"""
You are a Search Plan Generator for a Korean blogging platform.
Your task is to read the user question and output ONLY a JSON object that defines a safe search plan.

Context:
- now_utc: {now_utc}
- now_kst: {now_kst}
- timezone: {timezone}
- user_id: {user_id}
- category_id: {category_id}
- post_id: {post_id}
- defaults: {"top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"sort":"created_at_desc","limit":5}

Rules:
1) Output ONLY a single JSON object matching the schema below. No extra text.
2) Respect bounds: top_k 1..10, limit 1..20, threshold 0..1, weights in [0,1] and sum to 1.
3) If post_id exists, use mode="post" and include filters.post_id; else mode="rag".
4) If category_id exists, include it in filters.category_ids.
5) Interpret Korean temporal phrases into filters.time using the provided timezone.
   - “최근/최신/요즘”: prefer sort=created_at_desc. If a concrete period is given (e.g., 최근 30일), use relative.
   - “이번 달/이번 주/올해/올해 9월”: use month/year/quarter forms.
   - Month without year (e.g., “9월”): assume current year.
   - “지난주/지난달/작년”: use the respective period.
   - If ambiguous, omit time (server applies defaults).
6) If the question asks for N items (e.g., “N개”), set limit=N within bounds.
7) Keep the weights to defaults unless a clear need implies otherwise.

Schema:
{SCHEMA_JSON}

Question (Korean):
{question}

Respond with ONLY the JSON object. No markdown, no explanation.
"""

Few-shot 예시
- Q: "최근 글 보여줘"
  출력:
  {"mode":"rag","top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"filters":{"user_id":"{user_id}","time":{"type":"relative","unit":"day","value":30}},"sort":"created_at_desc","limit":5}

- Q: "9월 글 2개"
  출력:
  {"mode":"rag","top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"filters":{"user_id":"{user_id}","time":{"type":"month","month":9}},"sort":"created_at_desc","limit":2}

- Q: "카테고리 7의 최신 글 3개"
  출력:
  {"mode":"rag","top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"filters":{"user_id":"{user_id}","category_ids":[7]},"sort":"created_at_desc","limit":3}

- Q: "지난주에 쓴 포스트 중 추천해줘"
  출력:
  {"mode":"rag","top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"filters":{"user_id":"{user_id}","time":{"type":"relative","unit":"week","value":1}},"sort":"created_at_desc","limit":5}

- Q: "이 포스트(123) 기준으로 답해줘"
  출력:
  {"mode":"post","top_k":5,"threshold":0.2,"weights":{"chunk":0.7,"title":0.3},"filters":{"user_id":"{user_id}","post_id":123},"sort":"created_at_desc","limit":5}

검증 포인트(서버 측)
- JSON 파싱 실패 → v1 폴백
- 값 범위 초과 → 기본값/상한으로 교정
- time 표준화(절대 from/to 변환), 타임존 적용
- category_ids/post_id 소유권 확인
