BEGIN;

-- Rename the duplicate-detection table to clarify its purpose.
ALTER TABLE IF EXISTS ask_message_embedding RENAME TO ask_question_cache;

-- Keep naming consistent for the IVFFlat index if it already exists.
ALTER INDEX IF EXISTS idx_ask_message_embedding_vec RENAME TO idx_ask_question_cache_vec;

-- Store speech tone IDs with cached answers; -1 indicates unknown tone.
ALTER TABLE IF EXISTS ask_question_cache
  ADD COLUMN IF NOT EXISTS speech_tone_id integer NOT NULL DEFAULT -1;

-- Existing cache entries lack tone metadata, so drop them after the schema change.
TRUNCATE ask_question_cache;

COMMIT;
