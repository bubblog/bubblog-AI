# 프로젝트 계획: bubblog-ai (Express.js 마이그레이션)

## 1. 프로젝트 목표

기존 Python/FastAPI로 구현된 "bubblog-ai" 서비스를 **Node.js, Express.js, TypeScript** 스택으로 성공적으로 마이그레이션합니다. 이 과정에서 코드의 품질, 유지보수성, 확장성을 높이는 것을 목표로 합니다.

## 2. 기술 스택 (Target)

- **언어**: TypeScript v5.x
- **런타임**: Node.js v20.x
- **프레임워크**: Express.js v4.x
- **데이터베이스**: PostgreSQL + `pgvector`
- **Node.js DB 드라이버**: `node-postgres` (pg), `pgvector`
- **AI/LLM**: `openai` (OpenAI Node.js SDK)
- **인증**: `jsonwebtoken` (JWT 기반)
- **데이터 유효성 검사**: `zod`
- **환경 변수**: `dotenv`
- **컨테이너**: Docker

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

## 4. 작업 계획 (Task List)

상세 작업 계획은 `EXPRESS_MIGRATION.md` 파일의 "3. 작업 계획 (Task List)" 섹션을 따릅니다.