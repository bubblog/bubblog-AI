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

### 가상환경 설정

```bash
# macOS/Linux
source .venv/bin/activate

# Windows
venv\Scripts\activate
```

### 의존성 설치

```bash
pip install -r requirements.txt
```

### 서버 실행

```bash
uvicorn app.main:app --reload
```
