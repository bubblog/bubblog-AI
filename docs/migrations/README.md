# Migrations Guide

This folder contains SQL scripts for optional indexes/extensions used by the AI services.

## Apply pg_trgm for text search

File: `2025-01-pgtrgm.sql`

Purpose:
- Enable `pg_trgm` extension and add GIN indexes on `post_chunks.content` and `blog_post.title` to accelerate partial/fuzzy text search used in hybrid search.

Run (with `DATABASE_URL`):

```bash
psql "$DATABASE_URL" -f docs/migrations/2025-01-pgtrgm.sql
```

Or inside `psql`:

```sql
\i docs/migrations/2025-01-pgtrgm.sql
```

Notes:
- Indexes increase disk usage and write overhead; create only on columns used for text search.
- The extension must be installed once per database.

## Create ASK session/message tables

File: `2025-02-ask-session-history.sql`

Purpose:
- Create `ask_session`, `ask_message`, and `ask_message_embedding` tables with the indexes needed for session history APIs.
- Ensure the `vector` extension is enabled so question embeddings can be stored for duplicate-detection.

Run:

```bash
psql "$DATABASE_URL" -f docs/migrations/2025-02-ask-session-history.sql
```

Notes:
- The IVFFlat index requires a populated table before it becomes efficient; run `ANALYZE ask_message_embedding;` after bulk loading data.
- `ask_message_embedding` references `ask_message`, so dropping the session tables will cascade to embeddings automatically.
