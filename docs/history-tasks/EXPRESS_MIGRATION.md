# Express.js (TypeScript) 기반 AI 서비스 마이그레이션 요구사항

이 문서는 기존 Python/FastAPI로 구현된 AI 백엔드 서비스를 Node.js, Express.js, TypeScript 스택으로 마이그레이션하기 위한 시스템 요구사항과 API 명세를 정의합니다.

## 1. 시스템 요구사항

### 1.1. 기술 스택 및 환경
- **런타임**: Node.js v20.x 이상
- **언어**: TypeScript v5.x 이상
- **프레임워크**: Express.js v4.x
- **데이터베이스**: PostgreSQL
  - **확장**: `pgvector`
  - **Node.js 드라이버**: `node-postgres` (pg) 및 `pgvector`
- **AI/LLM**: `openai` (OpenAI Node.js SDK)
- **인증**: JWT (JSON Web Token) 기반 인증 (`jsonwebtoken` 라이브러리 사용)
- **데이터 유효성 검사**: `zod` 또는 `class-validator`를 사용하여 API 요청/응답 데이터 구조의 유효성을 검사 (기존 Pydantic 역할 대체)
- **환경 변수 관리**: `.env` 파일을 통한 환경 변수 관리 (`dotenv` 라이브ar리 사용)
- **컨테이너화**: Node.js 애플리케이션을 위한 `Dockerfile` 작성
- **TypeScript 설정**: `tsconfig.json` 파일을 통해 엄격한 타입 검사(`strict: true`) 및 모듈 해석(`moduleResolution: "node"`) 설정

### 1.2. 핵심 기능 요구사항
- **비동기 처리**: Node.js의 이벤트 기반, 논블로킹 I/O 모델을 최대한 활용하여 모든 I/O 작업(DB 쿼리, OpenAI API 호출 등)을 비동기적으로 처리해야 합니다.
- **임베딩 생성**:
    - 텍스트를 의미 단위(문장)로 분할하고, OpenAI 임베딩 모델의 토큰 제한에 맞게 청크로 만드는 로직을 구현해야 합니다. (`tiktoken`의 Node.js 버전 또는 유사 라이브러리 사용)
    - OpenAI API를 호출하여 텍스트 청크와 제목에 대한 벡터 임베딩을 생성해야 합니다.
- **데이터베이스 연동**:
    - `node-postgres` (pg)를 사용하여 PostgreSQL 데이터베이스 커넥션 풀을 관리해야 합니다.
    - `pgvector` 라이브러리를 사용하여 벡터 데이터를 DB에 저장하고, 코사인 유사도 검색을 수행해야 합니다.
    - 기존 `post_chunks` 및 `post_title_embeddings` 테이블 스키마와 호환되어야 합니다.
- **하이브리드 검색**:
    - 사용자의 질문에 대해 제목과 본문 임베딩의 유사도를 가중치(alpha, beta)를 두어 합산하는 하이브리드 검색 로직을 동일하게 구현해야 합니다.
- **스트리밍 API (SSE)**:
    - `/ai/ask` 엔드포인트는 Server-Sent Events (SSE)를 사용하여 LLM의 답변을 클라이언트에 실시간으로 스트리밍해야 합니다.
- **인증**:
    - `/ai/ask` 엔드포인트는 요청 헤더의 `Authorization: Bearer <token>`을 통해 JWT를 수신하고, 이를 검증하는 미들웨어를 구현해야 합니다.
- **오류 처리**:
    - API 요청 처리 중 발생하는 오류(DB 오류, API 키 오류, 유효성 검사 실패 등)를 일관된 형식으로 처리하고, 적절한 HTTP 상태 코드를 반환하는 중앙 오류 처리 미들웨어를 구현해야 합니다.

### 1.3. 프로젝트 구조 (권장)
```
/
├── src/
│   ├── app.ts            # Express 앱 설정 및 미들웨어 등록
│   ├── server.ts         # 서버 시작점
│   ├── config.ts         # 환경 변수 관리
│   ├── routes/           # API 라우트 정의
│   │   └── ai.routes.ts
│   ├── controllers/      # 요청 처리 및 응답 로직
│   │   └── ai.controller.ts
│   ├── services/         # 비즈니스 로직 (임베딩, Q&A 등)
│   │   ├── embedding.service.ts
│   │   └── qa.service.ts
│   ├── middlewares/      # 인증, 오류 처리 등 미들웨어
│   │   └── auth.middleware.ts
│   ├── utils/            # 공통 유틸리티 함수 (DB 연결 등)
│   │   └── db.ts
│   └── types/            # 데이터 타입 및 인터페이스 정의
│       └── ai.types.ts
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env
```

---

## 2. API 문서

### 공통 사항
- **Base URL**: `/ai`
- **인증**: `[인증 필요]`로 표시된 엔드포인트는 HTTP 헤더에 `Authorization: Bearer <JWT>`를 포함해야 합니다.

---

### `GET /ai/health`
- **설명**: 서비스의 상태를 확인하는 헬스 체크 엔드포인트입니다.
- **인증**: 필요 없음
- **응답 (200 OK)**:
  ```json
  {
    "status": "ok"
  }
  ```

---

### `POST /ai/embeddings/title`
- **설명**: 블로그 게시물의 제목을 임베딩하고 데이터베이스에 저장합니다. 기존에 해당 `post_id`의 제목 임베딩이 있으면 덮어씁니다.
- **인증**: 필요 없음 (보안 요구사항에 따라 JWT 인증 추가 고려)
- **Request Body**: `application/json`
  ```json
  {
    "post_id": 123,
    "title": "새로운 블로그 게시물 제목"
  }
  ```
  - **`post_id`** (number, required): 게시물의 고유 ID.
  - **`title`** (string, required): 임베딩할 게시물 제목.
- **응답 (200 OK)**:
  ```json
  {
    "ok": true
  }
  ```

---

### `POST /ai/embeddings/content`
- **설명**: 블로그 게시물의 본문을 청크로 분할하여 임베딩하고 데이터베이스에 저장합니다. 기존에 해당 `post_id`의 본문 임베딩이 있으면 모두 삭제 후 새로 저장합니다.
- **인증**: 필요 없음 (보안 요구사항에 따라 JWT 인증 추가 고려)
- **Request Body**: `application/json`
  ```json
  {
    "post_id": 123,
    "content": "이것은 블로그 게시물의 전체 본문 내용입니다..."
  }
  ```
  - **`post_id`** (number, required): 게시물의 고유 ID.
  - **`content`** (string, required): 임베딩할 게시물 본문.
- **응답 (200 OK)**:
  ```json
  {
    "post_id": 123,
    "chunk_count": 5,
    "success": true
  }
  ```
  - **`chunk_count`**: 생성된 텍스트 청크의 수.

---

### `POST /ai/ask`
- **설명**: 사용자의 질문에 대해 블로그 콘텐츠를 기반으로 답변을 생성하고 SSE(Server-Sent Events)로 스트리밍합니다.
- **인증**: **[인증 필요]**
- **Request Body**: `application/json`
  ```json
  {
    "question": "이 블로그의 주요 주제는 무엇인가요?",
    "user_id": "user-uuid-1234",
    "category_id": 10,
    "speech_tone": -1
  }
  ```
  - **`question`** (string, required): 사용자의 질문.
  - **`user_id`** (string, required): 질문한 사용자의 ID.
  - **`category_id`** (number, optional): 검색 범위를 좁힐 카테고리 ID.
  - **`speech_tone`** (number, optional): 답변 말투를 지정하는 ID.
    - `-1`: 간결하고 명확한 말투 (기본값)
    - `-2`: 블로그 본문과 유사한 말투
    - `양수`: DB에 저장된 특정 페르소나 ID
- **응답 (200 OK)**: `text/event-stream`
  - **이벤트**: `exist_in_post_status`
    - **데이터**: `true` 또는 `false`. 질문과 관련된 콘텐츠가 블로그에 존재하는지 여부.
    - **예시**: `event: exist_in_post_status
data: true

`
  - **이벤트**: `context`
    - **데이터**: AI가 답변의 근거로 참고한 게시물 정보 배열 (JSON 문자열).
    - **예시**: `event: context
data: [{"post_id":"123","post_title":"게시물 제목"}]

`
  - **이벤트**: `answer`
    - **데이터**: LLM이 생성하는 답변의 일부 (텍스트 조각).
    - **예시**: `event: answer
data: '답변의 첫 부분입니다.'

`
  - **이벤트**: `end`
    - **데이터**: `[DONE]`. 스트림의 끝을 알림.
    - **예시**: `event: end
data: [DONE]

`

---

## 3. 작업 계획 (Task List)

### Phase 1: 프로젝트 초기 설정
- [ ] **Task 1.1**: `npm init -y` 명령 실행 및 `package.json` 기본 정보 설정
- [ ] **Task 1.2**: TypeScript 및 필수 라이브러리 설치 (`typescript`, `ts-node`, `nodemon`, `@types/node`)
- [ ] **Task 1.3**: `tsconfig.json` 파일 생성 및 컴파일러 옵션 설정 (strict, moduleResolution 등)
- [ ] **Task 1.4**: Express 관련 라이브러리 설치 (`express`, `@types/express`)
- [ ] **Task 1.5**: 권장 프로젝트 구조에 따라 디렉터리 생성 (`src`, `src/routes`, `src/controllers` 등)

### Phase 2: 핵심 인프라 구축
- [ ] **Task 2.1**: 기본 Express 서버 설정 (`src/server.ts`, `src/app.ts`)
- [ ] **Task 2.2**: 환경 변수 관리 모듈 구현 (`dotenv` 설치 및 `src/config.ts` 작성)
- [ ] **Task 2.3**: 데이터베이스 연동 모듈 구현 (`pg`, `pg-vector` 설치 및 `src/utils/db.ts` 작성)
- [ ] **Task 2.4**: `GET /ai/health` 엔드포인트 구현으로 기본 라우팅 및 서버 동작 검증

### Phase 3: 임베딩 기능 구현
- [ ] **Task 3.1**: 데이터 유효성 검사 라이브러리 설치 (`zod`)
- [ ] **Task 3.2**: 임베딩 관련 API 요청/응답 타입 정의 (`src/types/ai.types.ts`)
- [ ] **Task 3.3**: OpenAI 및 토크나이저 라이브러리 설치 (`openai`, `@dqbd/tiktoken`)
- [ ] **Task 3.4**: `embedding.service.ts` 구현
    - [ ] 텍스트 청킹(`chunk_text`) 함수 구현
    - [ ] 임베딩 생성(`embed_texts`) 및 DB 저장(`store_embeddings`, `store_title_embedding`) 함수 구현
- [ ] **Task 3.5**: `ai.controller.ts`에 임베딩 관련 컨트롤러 함수 구현
- [ ] **Task 3.6**: `ai.routes.ts`에 `POST /ai/embeddings/title`, `POST /ai/embeddings/content` 라우트 등록

### Phase 4: Q&A 기능 구현
- [ ] **Task 4.1**: JWT 라이브러리 설치 (`jsonwebtoken`, `@types/jsonwebtoken`)
- [ ] **Task 4.2**: JWT 인증 미들웨어 구현 (`src/middlewares/auth.middleware.ts`)
- [ ] **Task 4.3**: `qa.service.ts` 구현
    - [ ] 하이브리드 검색(`similar_chunks`) 함수 구현
    - [ ] SSE 기반 답변 스트리밍(`answer_stream`) 함수 구현 (프롬프트 구성, OpenAI API 호출 포함)
- [ ] **Task 4.4**: `ai.controller.ts`에 `ask` 컨트롤러 함수 구현
- [ ] **Task 4.5**: `ai.routes.ts`에 `POST /ai/ask` 라우트 등록 및 인증 미들웨어 적용

### Phase 5: 최종화 및 배포 준비
- [ ] **Task 5.1**: 중앙 오류 처리 미들웨어 구현
- [ ] **Task 5.2**: `package.json`에 `start`, `build`, `dev` 스크립트 추가
- [ ] **Task 5.3**: Node.js 애플리케이션을 위한 `Dockerfile` 작성
- [ ] **Task 5.4**: 최종 테스트 및 코드 리뷰