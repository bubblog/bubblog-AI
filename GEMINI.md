# 프로젝트 문서: bubblog-ai (Express.js 기반 AI 서비스)

## 1. 프로젝트 개요

이 프로젝트는 블로그 플랫폼 "bubblog"를 위한 AI 기반 백엔드 서비스입니다. Node.js, Express.js, TypeScript 스택으로 구현되었으며, OpenAI의 언어 모델을 활용하여 블로그 콘텐츠에 대한 임베딩 생성 및 지능형 질의응답(Q&A) 기능을 제공합니다.

주요 목표는 사용자가 블로그에 작성된 내용을 기반으로 질문했을 때, AI가 관련 내용을 찾아 답변을 생성해주는 것입니다. 이를 위해 PostgreSQL 데이터베이스와 `pgvector` 확장을 사용하여 벡터 유사도 검색을 수행합니다.

## 2. 기술 스택

- **런타임**: Node.js v20.x 이상
- **언어**: TypeScript v5.x 이상
- **프레임워크**: Express.js v4.x
- **데이터베이스**: PostgreSQL
  - **확장**: `pgvector`
  - **Node.js 드라이버**: `node-postgres` (pg) 및 `pgvector`
- **AI/LLM**: `openai` (OpenAI Node.js SDK)
- **인증**: JWT (JSON Web Token) 기반 인증 (`jsonwebtoken` 라이브러리 사용)
- **데이터 유효성 검사**: `zod`
- **환경 변수 관리**: `.env` 파일을 통한 환경 변수 관리 (`dotenv` 라이브러리 사용)
- **컨테이너화**: Docker

## 3. 코딩 컨벤션 및 스타일 가이드

모든 코드는 다음 규칙을 엄격히 준수합니다.

- **함수 스타일**: **화살표 함수(Arrow Function)** 사용을 원칙으로 합니다.
  ```typescript
  // Good
  const myFunction = (item: string): void => {
    console.log(item);
  };

  // Bad
  function myFunction(item) {
    console.log(item);
  }
  ```
- **단일 책임 원칙**: 함수는 **단 하나의 행동**만을 수행하도록 작성합니다.
- **변수명**: 
    - **축약 금지**: 변수명은 의미를 명확하게 전달할 수 있도록 축약하지 않습니다. 람다(콜백) 함수의 인자도 마찬가지입니다.
      ```typescript
      // Good
      const findUserById = (userList: User[], targetId: number) => {
        return userList.find((user) => user.id === targetId);
      };

      // Bad
      const findUser = (u, id) => {
        return u.find(i => i.id === id);
      }
      ```
  
### 3.5 네이밍 규칙

#### 변수/상수 (camelCase)
- **축약 금지**. 다만 관용 약어는 허용: `id`, `URL`, `HTML`, `CSS`, `API`, `DTO`.
- 불리언: `is*`, `has*`, `can*`, `should*`.
- 단위 접미사: `timeoutMs`, `sizePx`, `priceCents`.

#### 컬렉션 이름
- **배열**: **복수형 명사**. `users`, `orders`
- **ID 배열**: `userIds`, `orderIds`
- **Set**: `selectedUserSet`, `userIdSet`
- **Map/Record**: `usersById: Record<UserId, User>`, `priceBySku: Map<string, number>`
- `List`/`Array` 접미사는 모호할 때만 사용. 예: `filteredUsers`가 충분히 명확하면 접미사 불필요.

#### 함수 (camelCase)
- 동사 + 목적어: `getUser`, `createUser`, `updateUser`, `deleteUser`.
- 비동기: `*Async` 접미사. 예: `createUserAsync`.
- 서비스 계층은 도메인 용어 사용: `issueToken`, `hashPassword`.

#### 타입/인터페이스/클래스 (PascalCase)
- 엔티티: `User`, `Post` / DTO: `CreateUserRequest`, `CreateUserResponse`.
- 요청 스키마 타입: `GetUserParams`, `ListUsersQuery`, `CreateUserBody`.

#### 파일/폴더
- 일반 모듈: `kebab-case.ts`
- 라우터: `*.route.ts`, 컨트롤러: `*.controller.ts`, 서비스: `*.service.ts`, 레포: `*.repository.ts`.
- 테스트: `*.spec.ts` / `*.test.ts`.

## 4. 핵심 기능

- **비동기 처리**: Node.js의 이벤트 기반, 논블로킹 I/O 모델을 최대한 활용하여 모든 I/O 작업(DB 쿼리, OpenAI API 호출 등)을 비동기적으로 처리합니다.
- **임베딩 생성**:
    - 텍스트를 의미 단위(문장)로 분할하고, OpenAI 임베딩 모델의 토큰 제한에 맞게 청크로 만드는 로직을 구현합니다.
    - OpenAI API를 호출하여 텍스트 청크와 제목에 대한 벡터 임베딩을 생성합니다.
- **데이터베이스 연동**: PostgreSQL 데이터베이스 커넥션 풀을 관리하고, `pgvector`를 사용하여 벡터 데이터를 DB에 저장하고, 코사인 유사도 검색을 수행합니다.
- **하이브리드 검색**: 사용자의 질문에 대해 제목과 본문 임베딩의 유사도를 가중치(alpha, beta)를 두어 합산하는 하이브리드 검색 로직을 구현합니다.
- **스트리밍 API (SSE)**: `/ai/ask` 엔드포인트는 Server-Sent Events (SSE)를 사용하여 LLM의 답변을 클라이언트에 실시간으로 스트리밍합니다.
- **인증**: `/ai/ask` 엔드포인트는 요청 헤더의 `Authorization: Bearer <token>`을 통해 JWT를 수신하고, 이를 검증하는 미들웨어를 구현합니다.
- **오류 처리**: API 요청 처리 중 발생하는 오류를 일관된 형식으로 처리하고, 적절한 HTTP 상태 코드를 반환하는 중앙 오류 처리 미들웨어를 구현합니다.

## 5. 프로젝트 구조

```
/
├── src/
│   ├── app.ts            # Express 앱 설정 및 미들웨어 등록
│   ├── server.ts         # 서버 시작점
│   ├── config.ts         # 환경 변수 관리
│   ├── routes/
│   │   └── ai.routes.ts
│   ├── controllers/
│   │   └── ai.controller.ts
│   ├── services/
│   │   ├── embedding.service.ts
│   │   └── qa.service.ts
│   ├── middlewares/
│   │   └── auth.middleware.ts
│   ├── utils/
│   │   └── db.ts
│   └── types/
│       └── ai.types.ts
├── Dockerfile
├── package.json
├── tsconfig.json
└── .env
```

## 6. API 문서

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
- **설명**: 사용자의 질문에 대해 블로그 콘텐츠를 기반으로 답변을 생성하고 SSE(Server-Sent Events)로 스트리밍합니다. `post_id`를 지정하면 해당 게시물 내용만으로 답변하고, 지정하지 않으면 사용자의 전체 게시물 또는 특정 카테고리 내에서 답변을 탐색합니다.
- **인증**: **[인증 필요]**
- **Request Body**: `application/json`
  ```json
  {
    "question": "이 블로그의 주요 주제는 무엇인가요?",
    "user_id": "user-uuid-1234",
    "category_id": 10,
    "post_id": 123,
    "speech_tone": -1
  }
  ```
  - **`question`** (string, required): 사용자의 질문.
  - **`user_id`** (string, required): 질문한 사용자의 ID.
  - **`category_id`** (number, optional): 검색 범위를 좁힐 카테고리 ID. `post_id`가 지정되면 이 값은 무시됩니다.
  - **`post_id`** (number, optional): 대화 범위를 특정 게시물로 한정할 ID.
  - **`speech_tone`** (number, optional): 답변 말투를 지정하는 ID.
    - `-1`: 간결하고 명확한 말투 (기본값)
    - `-2`: 블로그 본문과 유사한 말투
    - `양수`: DB에 저장된 특정 페르소나 ID
- **응답 (200 OK)**: `text/event-stream`
  - **이벤트**: `exist_in_post_status`
    - **데이터**: `true` 또는 `false`. 질문과 관련된 콘텐츠가 블로그에 존재하는지 여부.
    - **예시**: `event: exist_in_post_status\ndata: true\n\n`
  - **이벤트**: `context`
    - **데이터**: AI가 답변의 근거로 참고한 게시물 정보 배열 (JSON 문자열).
    - **예시**: `event: context\ndata: [{"post_id":"123","post_title":"게시물 제목"}]\n\n`
  - **이벤트**: `answer`
    - **데이터**: LLM이 생성하는 답변의 일부 (텍스트 조각).
    - **예시**: `event: answer\ndata: '답변의 첫 부분입니다.'\n\n`
  - **이벤트**: `end`
    - **데이터**: `[DONE]`. 스트림의 끝을 알림.
    - **예시**: `event: end\ndata: [DONE]\n\n`
