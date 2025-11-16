BEGIN;

-- Ensure pgvector extension is available for embedding storage
CREATE EXTENSION IF NOT EXISTS vector;

-- Persist ASK session metadata
CREATE TABLE IF NOT EXISTS ask_session (
  id BIGSERIAL PRIMARY KEY,
  requester_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  title TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_question_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_session_requester_created_at
  ON ask_session (requester_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ask_session_owner_created_at
  ON ask_session (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ask_session_last_question_at
  ON ask_session (last_question_at DESC NULLS LAST);

-- Persist individual ASK messages (user + assistant turns)
CREATE TABLE IF NOT EXISTS ask_message (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES ask_session(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  search_plan JSONB,
  retrieval_meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_message_session_created_at
  ON ask_message (session_id, created_at DESC, id DESC);

-- Store embeddings for dedupe/cache checks
CREATE TABLE IF NOT EXISTS ask_message_embedding (
  message_id BIGINT PRIMARY KEY REFERENCES ask_message(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  category_id BIGINT,
  post_id BIGINT,
  answer_message_id BIGINT REFERENCES ask_message(id),
  embedding VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_message_embedding_owner
  ON ask_message_embedding (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_ask_message_embedding_owner_category
  ON ask_message_embedding (owner_user_id, category_id);

CREATE INDEX IF NOT EXISTS idx_ask_message_embedding_owner_post
  ON ask_message_embedding (owner_user_id, post_id);

CREATE INDEX IF NOT EXISTS idx_ask_message_embedding_requester
  ON ask_message_embedding (requester_user_id);

-- IVF FLAT index for similarity search (requires ANALYZE after large inserts)
CREATE INDEX IF NOT EXISTS idx_ask_message_embedding_vec
  ON ask_message_embedding
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMIT;
