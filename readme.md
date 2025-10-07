# pgvector 설치 및 AI 서버 구동 문서

## 1. PostgreSQL에 pgvector 설치

### macOS

```bash
brew install pgvector
```

### Ubuntu

```bash
sudo apt update
sudo apt install postgresql-server-dev-14  # PostgreSQL 버전에 따라 수정
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install
```

### Docker

```Dockerfile
FROM postgres:14
RUN apt-get update && apt-get install -y postgresql-server-dev-14 git make gcc
RUN git clone https://github.com/pgvector/pgvector.git && cd pgvector && make && make install
```

### PostgreSQL 접속 후

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

---

## 2. 임베딩 테이블 생성

### 블로그 본문 청크 테이블

```sql
CREATE TABLE post_chunks (
  post_id     BIGINT     NOT NULL,
  chunk_index INT        NOT NULL,
  content     TEXT       NOT NULL,
  embedding   VECTOR(1536) NOT NULL,
  PRIMARY KEY (post_id, chunk_index),
  FOREIGN KEY (post_id)
    REFERENCES blog_post(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_post_chunks_embedding
  ON post_chunks
  USING hnsw (embedding vector_cosine_ops);
```

### 블로그 제목 임베딩 테이블

```sql
CREATE TABLE post_title_embeddings (
  post_id   BIGINT       NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  FOREIGN KEY (post_id)
    REFERENCES blog_post(id)
    ON DELETE CASCADE
);

CREATE INDEX idx_post_title_embeddings_embedding
  ON post_title_embeddings
  USING hnsw (embedding vector_cosine_ops);
```

---

## 3. HNSW 인덱스란?

* ANN (Approximate Nearest Neighbor) 그래프 기반 인덱스 구조
* 빠른 탐색, 높은 정확도
* 소규모 데이터셋에서도 ivfflat보다 우수한 성능
* PostgreSQL에서는 pgvector v0.5.0+부터 지원 (`USING hnsw`)
* 데이터량 많아지면 `ivfflat`으로 변경 고려

---

## 4. AI 서버 작동

### `.env` 파일 작성 (루트 디렉토리 `BUBBLOG_AI`에 위치)

---

## 5. 텍스트 검색 인덱스 (pg_trgm)

하이브리드 검색의 키워드/부분일치 성능 향상을 위해 `pg_trgm` 확장 및 GIN 인덱스를 추가합니다.

### 5.1 확장 및 인덱스 생성 스크립트

프로젝트에 제공된 스크립트를 사용하세요:

`docs/migrations/2025-01-pgtrgm.sql`

내용:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_pc_content_trgm ON post_chunks USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_bp_title_trgm   ON blog_post   USING gin (title   gin_trgm_ops);
```

### 5.2 적용 방법

- 환경변수 `DATABASE_URL`이 설정된 경우:

```bash
psql "$DATABASE_URL" -f docs/migrations/2025-01-pgtrgm.sql
```

- 또는 npm 스크립트 사용:

```bash
npm run db:migrate:pgtrgm
```

- 또는 수동 실행(PostgreSQL 쉘 접속 후):

```sql
\i docs/migrations/2025-01-pgtrgm.sql
```

주의: 인덱스는 쓰기 비용과 디스크 사용량을 증가시킵니다. 텍스트 검색에 사용하는 컬럼(`post_chunks.content`, `blog_post.title`)에만 생성하세요.
