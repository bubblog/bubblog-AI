-- Enable pg_trgm and add GIN indexes for text search on content and title
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_pc_content_trgm
  ON post_chunks USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_bp_title_trgm
  ON blog_post USING gin (title gin_trgm_ops);

