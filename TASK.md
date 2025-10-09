## 작업 계획

작업 순서
- 1) LLM 모듈화(퍼사드/프로바이더/모델 레지스트리) + GPT-5 mini 기본 적용
- 2) Gemini 도입: 병행 사용(전용) + 대체 사용(퍼사드)
- 3) 토큰 카운트 및 비용 로깅 추가(양 프로바이더 공통)

참고: 아래 문서의 섹션 순서와 무관하게 실제 구현 순서는 위의 "작업 순서"를 따릅니다.


### 1) LLM 모듈화(퍼사드/프로바이더/모델 레지스트리) + GPT-5 mini 기본 적용

목적: LLM 호출을 모듈화하여 옵션 기반으로 모델/프로바이더를 교체 가능하게 만들고, 기본 모델을 `gpt-5-mini`로 전환합니다. 토크나이저/가격표는 3단계에서 처리합니다.

1. [구조] 파일/모듈 구성
   - 디렉토리: `src/llm/`
     - `src/llm/types.ts` — 공통 인터페이스 정의
       - `GenerateRequest`: `{ provider?: 'openai'|'gemini', model?: string, messages?: OpenAIStyleMessages, contents?: GeminiStyleContents, stream?: boolean, tools?, options?: { temperature?, top_p?, max_output_tokens?, reasoning?, text? }, meta?: { userId?, categoryId?, postId? } }`
       - `GenerateStream`: `onToken(text)`, `onToolCall(json)`, `onEnd()`, `onError(err)`(또는 AsyncIterable)
     - `src/llm/modelRegistry.ts` — 모델 레지스트리/기본값
       - 논리 모델 키 → `{ provider, modelId, defaults, tokenizerKey?, pricingKey? }`
       - 기본값: `defaultChat = { provider: 'openai', modelId: 'gpt-5-mini' }`
     - `src/llm/providers/openaiResponses.ts` — OpenAI Responses API 구현
     - `src/llm/providers/gemini.ts` — @google/gemini 구현
     - `src/llm/index.ts` — 퍼사드: `generate(req: GenerateRequest): GenerateStream` 선택 라우팅
   - 기존 서비스(`qa.service.ts`)는 퍼사드만 사용하도록 변경

2. [기본 모델] GPT-5 mini 적용(Responses API)
   - `src/config.ts`의 `CHAT_MODEL` 기본값을 `gpt-5-mini`로 변경
   - OpenAI 경로: `openai.responses.create/stream`로 마이그레이션(SSE 어댑터 포함)
   - 기존 Chat Completions 경로는 임시 백업/옵션으로 유지 가능(필요 시)

3. [옵션 기반 모델/프로바이더 선택]
   - 요청 바디에 `llm?: { provider?: 'openai'|'gemini', model?: string, options?: {...} }` 허용
   - 미지정 시 레지스트리의 기본값 사용(`gpt-5-mini` on OpenAI)
   - 향후 기능(Reasoning/Text 옵션, tool calls, timeout 등) 확장 용이

4. [검증/수용 기준]
   - `/ai/ask` SSE 정상 동작(중단/지연 없음)
   - 기존 프롬프트/툴 호출이 동일하게 동작(필요 시 어댑터)
   - 로그/오류 처리 기존 수준 유지
   
### 2) Gemini 도입: 병행 사용(전용) + 대체 사용(퍼사드)

목적: Gemini를 독립 엔드포인트로 직접 쓰는 경로와, 기존 GPT 경로의 대체 제공자로 모두 사용할 수 있게 합니다(퍼사드 경유). 이후 3단계에서 토큰/비용 로깅을 공통 적용합니다.

1. [Config] Gemini 키/모델 설정
   - `.env`
     - `GEMINI_API_KEY=...`
     - `GEMINI_CHAT_MODEL=gemini-2.5-flash` (예: 변경 가능)
   - `src/config.ts`에 항목 반영 및 기본값/검증 추가(Provider 고정 ENV는 사용하지 않음)

2. [Provider] 퍼사드에 Gemini 구현 추가
   - 1단계에서 만든 LLM 퍼사드(`src/llm/index.ts`)에 Gemini 프로바이더를 추가
   - 구현 위치: `src/llm/providers/gemini.ts` (OpenAI 구현은 `src/llm/providers/openaiResponses.ts`)
   - 퍼사드 인터페이스로 라우팅되어 기존 `qa.service.ts`는 퍼사드만 사용(교체 투명)

3. [Gemini 호출] @google/genai SDK 적용 및 스트리밍
   - 의존성: `@google/genai` 추가 (설치 커맨드: `npm i @google/genai`)
   - 클라이언트: `import { GoogleGenAI } from "@google/genai"; const ai = new GoogleGenAI({});` (`GEMINI_API_KEY`는 환경변수에서 자동 주입)
   - 비스트리밍(우선 적용):
     - `ai.models.generateContent({ model: GEMINI_CHAT_MODEL, contents, config: { thinkingConfig: { thinkingBudget }}})`
     - 기본값으로 `thinkingBudget=0`(생각 비활성화) 적용, `.env`에서 오버라이드 가능
     - 응답 텍스트를 한번에 수신한 뒤 SSE로 순차 chunk 분할하여 `answer` 이벤트로 전송(간단 구현)
   - 스트리밍(선택 적용):
     - SDK 제공 시 스트리밍 API 사용(예: `generateContentStream` 유사 기능)으로 델타를 받아 즉시 SSE로 전달
     - SDK에서 미지원일 경우, 비스트리밍으로 우선 릴리즈 후 스트리밍 전환
   - (옵션) Safety 설정, generationConfig(temperature/topP/maxOutputTokens) 파라미터는 설정값으로 노출

5. [토큰 카운팅] Gemini 대응
   - 사전 카운트(가능 시): SDK의 토큰 카운트 API(`tokens:count`/`countTokens`)가 제공되면 이를 사용해 프롬프트 토큰 계산 → 비용 선로깅
     - 네트워크 요청이므로 로깅 토글이 켜져 있을 때만 수행하도록 옵션화
   - 사후 카운트: 응답 텍스트 기준 동일 API로 출력 토큰 계산(또는 비가용 시 근사치)
   - 폴백 전략: 카운트 API가 불가한 환경에서는 근사치 사용(문자수/4), 추후 정확도 개선 시 교체

6. [가격 정책] Gemini 추가
   - `src/config/pricing.ts`의 `PRICING_TABLE`에 Gemini 모델(`gemini-2.5-flash`, 임베딩 모델 등) 단가 추가
   - 동일한 `calcCost`, `formatCost` 로직 재사용

7. [생각(Thinking) 설정] 기본 비활성화
   - Gemini 2.5 Flash의 생각 기능은 응답 품질 대신 비용/지연이 증가하므로 기본 `thinkingBudget=0`으로 비활성화
   - `.env`에 `GEMINI_THINKING_BUDGET`를 두어 필요 시 활성화(정수값)

8. [도구/함수 호출] 호환성 계획(선택)
   - 현재 OpenAI `tool_calls`를 사용 중. Gemini는 `functionDeclarations`/`toolConfig` 형태로 유사 기능 제공
   - 1단계: Gemini 경로에서는 도구 호출 비활성화(빠른 도입)
   - 2단계: 필요 시 `report_content_insufficient`를 Gemini `functionDeclarations`로 매핑하여 동일 동작 구현

9. [Wiring] 사용 패턴
   - 독립 사용(A): `POST /ai/gemini/ask`로 직접 호출(옵션: thinkingBudget 등)
   - 대체 사용(B): 기존 `POST /ai/ask`에 `llm.provider?: 'openai'|'gemini'`, `llm.model?` 허용 → 퍼사드가 라우팅
   - 로깅 시 `provider` 필드를 포함(3단계에서 적용)

10. [검증/수용 기준]
   - OpenAI/Gemini 각각에서 동일한 SSE 응답 형식으로 동작
   - 요청 전/후 토큰·비용 로그가 두 프로바이더 모두에서 출력
   - 로깅 토글이 정상 작동, 스트리밍 성능 저하 없음

설정 확정
- `GEMINI_CHAT_MODEL=gemini-2.5-flash`
- `GEMINI_THINKING_BUDGET=0` (기본값으로 비활성화)

### 토큰 카운트 및 비용 로깅 추가

목적: LLM에 요청을 보내기 직전에 프롬프트(메시지) 토큰 수를 계산해 예상 입력 비용을 콘솔로 로깅하고, 스트리밍 응답 완료 후 실제 출력 토큰 수 기반 최종 비용을 추가 로깅합니다. 초기에는 `console.log`만 사용합니다.

1. [Utils] 토크나이저 유틸 추가
   - 파일: `src/utils/tokenizer.ts`
   - 내용:
     - `getTokenizerForModel(model: string)` → 모델명에 따라 적절한 인코딩을 선택
       - `gpt-5*` → 자료 제공 전까지 임시로 `o200k_base` 사용(TBD, 전환 시 교체)
       - `gpt-4o`, `gpt-4o-mini`, 기타 `o`계열 → `o200k_base`
     - `countTextTokens(text: string, model: string): number`
     - `countChatMessagesTokens(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[], model: string): number`
       - 메시지 `content`들을 토크나이즈하여 합산하고, 채팅 포맷 오버헤드(메시지당 소량, 모델별 상수)를 보정치로 가산
       - 주의: 보정치는 근사치이며, 정확한 정산은 응답 토큰 합산으로 후처리
   - 비고: 이미 프로젝트에 `@dqbd/tiktoken`이 포함되어 있으므로 이를 사용합니다.

2. [Config] 가격 정책 맵 구조 설계 (임시 하드코딩 + ENV 오버라이드)
   - 파일: `src/config/pricing.ts`
   - 내용:
     - `export type Pricing = { input_per_1k: number; output_per_1k: number; cached_input_per_1k?: number; currency: 'USD' | 'KRW' }`
     - `PRICING_TABLE: Record<string, Pricing>`: 모델명 키에 따른 단가 설정
     - 선택: `LLM_PRICING_OVERRIDES`(JSON) 환경변수로 런타임 오버라이드 허용
   - 초기값은 사용자 제공 정책으로 채울 예정. 제공 전까지는 로깅에 `N/A` 표기 또는 0 처리.

    - 초기 PRICING_TABLE(제공 정책 반영, 단위: per 1K tokens, 통화: USD)
      - `gpt-5`: { input_per_1k: 0.00125, cached_input_per_1k: 0.000125, output_per_1k: 0.01, currency: 'USD' }
      - `gpt-5-mini`: { input_per_1k: 0.00025, cached_input_per_1k: 0.000025, output_per_1k: 0.002, currency: 'USD' }
      - `gpt-5-nano`: { input_per_1k: 0.00005, cached_input_per_1k: 0.000005, output_per_1k: 0.0004, currency: 'USD' }

3. [Utils] 비용 계산 유틸 추가
   - 파일: `src/utils/cost.ts`
   - 내용:
     - `getModelPricing(model: string): Pricing | null`
     - `calcCost(tokens: number, per_1k: number): number` → 반올림 1~4자리(옵션)
     - 화폐 표기 함수(선택): `formatCost(amount: number, currency: string)`

4. [Facade] LLM 퍼사드에 비용 로깅 통합
   - 위치: `src/llm/index.ts` 퍼사드 내부에서 공통 로깅 수행
   - 기능 흐름(공통):
     1) 요청 전: 메시지/콘텐츠 토큰 카운트 → `promptTokens`
        - OpenAI: `countChatMessagesTokens`(토크나이저)
        - Gemini: `countTokens` API 가능 시 사용(불가 시 근사치)
     2) 단가 조회: `getModelPricing(model)` → `estInputCost`
     3) 선로깅: `{type:'llm.request', provider, model, promptTokens, estInputCost, corrId, userId, categoryId, postId}`
     4) 실제 호출: 등록된 프로바이더(OpenAI Responses 또는 Gemini)로 위임, 스트림은 그대로 중계
     5) 스트림 종료 후: 출력 텍스트/함수인자 토큰 합산 → `completionTokens`
     6) 비용 계산: 입력/출력(+cached 입력이 있으면 분리) → `totalCost`
     7) 후로깅: `{type:'llm.response', provider, model, promptTokens, completionTokens, inputCost, outputCost, totalCost, durationMs, corrId, cachedInputTokens}`
   - 주의: 기존 SSE 흐름(이벤트명/포맷) 불변 유지. 퍼사드는 원본 델타를 그대로 전달.
   - 상관관계 ID(`corrId`)는 `uuid` 생성(또는 요청별 식별자 전달 시 사용).

5. [Wiring] `qa.service.ts`에서 퍼사드 사용
   - 기존 직접 호출부를 LLM 퍼사드로 교체(`generate(req)`)
   - 요청 바디의 `llm` 옵션을 퍼사드에 그대로 전달(provider/model/options)
   - 출력 토큰 카운트/비용 로깅은 퍼사드 내부에서 처리

6. [옵션] 임베딩 호출 비용 로깅(확장)
   - 파일: `src/services/embedding.service.ts`
   - `createEmbeddings` 호출 직전 `input` 텍스트 전체 토큰 수 계산(`countTextTokens` 누적) → 입력 비용 로깅
   - 임베딩 모델 단가(`text-embedding-3-*`)도 `PRICING_TABLE`에 포함

7. [환경변수] 로깅 토글 및 라운딩
   - `.env` 키 추가(기본값은 off)
     - `LLM_COST_LOG=true|false` (기본: true로 해도 무방)
     - `LLM_COST_ROUND=2` (소수점 자리수, 선택)
   - 로깅은 토글 꺼져 있으면 수행하지 않음

8. [로그 포맷] 예시(JSON 라인)
   - 요청 전: `{ "type": "llm.request", "corrId": "...", "provider": "openai", "model": "gpt-5-mini", "promptTokens": 1234, "estInputCost": 0.00031, "userId": "...", "categoryId": 1, "postId": 42 }`
   - 응답 후: `{ "type": "llm.response", "corrId": "...", "provider": "openai", "model": "gpt-5-mini", "promptTokens": 1234, "completionTokens": 456, "inputCost": 0.00031, "outputCost": 0.00091, "totalCost": 0.00122, "durationMs": 987, "cachedInputTokens": 0 }`

9. [검증/수용 기준]
   - `POST /ai/ask` 호출 시 콘솔에 요청 전/후 로그 각각 1회 출력
   - 모델/프롬프트/토큰 수/예상 비용/총 비용/시간(ms)이 포함되어야 함
   - 로깅 on/off 토글 동작, 라운딩 반영 확인
   - 기존 SSE 동작(끊김/지연) 변화 없음

10. [주의/한계]
   - 채팅 포맷 오버헤드는 모델별로 상이하며 근사치 사용. 최종 비용은 출력 토큰 카운트까지 반영해 오차 최소화
   - 스트리밍 API는 서버에서 사용량 메타를 즉시 제공하지 않으므로(비스트리밍과 달리), 응답 텍스트 기반 자체 카운트 수행
   - 함수 호출(tool_calls) 토큰은 인자 길이에 비례하여 증가. 누적 텍스트/인자 기반으로 동일하게 카운트
   - Cached Input 과금: 제공 API에서 캐시 히트 토큰 정보를 명시적으로 제공하는 경우에만 `cachedInputTokens`로 분리 산정. 그렇지 않으면 일반 입력으로 계산(보수적)

11. [다음 단계(선택)]
   - `console.log` → 구조화 로거(Pino/Winston)로 교체, 샘플링·보존 기간 설정
   - DB 또는 시계열(예: ClickHouse/Prometheus) 적재로 사용자별 비용 대시보드 구성
