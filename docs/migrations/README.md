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

