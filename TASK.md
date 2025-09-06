## 리팩토링 계획

### Phase 1: Repository 계층 도입 (데이터 로직 분리)

1.  **[Repo] `src/repositories` 디렉토리 생성**: 데이터베이스 쿼리 로직을 모아둘 디렉토리를 생성합니다.
2.  **[Repo] `post.repository.ts` 생성 및 이전**:
    *   `blog_post`, `post_chunks`, `post_title_embeddings` 테이블 관련 쿼리를 이 파일로 옮깁니다.
    *   `qa.service.ts`의 `findPostById`, `findSimilarChunks` 로직을 이전합니다.
    *   `embedding.service.ts`의 `storeTitleEmbedding`, `storeContentEmbeddings` 로직을 이전합니다.
3.  **[Repo] `persona.repository.ts` 생성 및 이전**:
    *   `persona` 테이블 관련 쿼리를 이 파일로 옮깁니다.
    *   `qa.service.ts`의 `getSpeechTonePrompt` 내부 DB 조회 로직을 `findPersonaById`와 같은 함수로 분리하여 이전합니다.
4.  **[Service] 서비스 계층 수정**:
    *   `qa.service.ts`와 `embedding.service.ts`가 DB에 직접 접근하는 대신, 새로 만든 Repository의 함수를 호출하도록 코드를 수정합니다.

### Phase 2: 프롬프트 관리 분리

5.  **[Prompt] `src/prompts` 디렉토리 생성**: 프롬프트 템플릿을 관리할 디렉토리를 생성합니다.
6.  **[Prompt] `qa.prompts.ts` 파일 생성**:
    *   `qa.service.ts`에 하드코딩된 시스템 프롬프트와 사용자 메시지 생성 로직을 이 파일로 옮깁니다.
    *   `createRagPrompt`, `createPostContextPrompt`와 같이 동적으로 프롬프트를 생성하는 함수를 만듭니다.
7.  **[Service] `qa.service.ts` 수정**:
    *   `qa.prompts.ts`에서 프롬프트 생성 함수를 가져와(import) 사용하도록 수정합니다.