import pgvector from 'pgvector/pg';
import { getDb } from '../utils/db';

// ========= INTERFACES =========
export interface Post {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  user_id: string;
}

export interface SimilarChunk {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
}

export interface TextSearchHit {
  postId: string;
  postTitle: string;
  postChunk: string;
  textScore: number;
}

// ========= READ QUERIES =========
export const findPostById = async (postId: number): Promise<Post | null> => {
  const pool = getDb();
  const { rows } = await pool.query<Post>(
    'SELECT id, title, content, tags, created_at, user_id FROM blog_post WHERE id = $1',
    [postId]
  );
  return rows.length > 0 ? rows[0] : null;
};

export const findSimilarChunks = async (
  userId: string,
  questionEmbedding: number[],
  categoryId?: number
): Promise<SimilarChunk[]> => {
  const pool = getDb();
  const params: any[] = [userId, pgvector.toSql(questionEmbedding)];
  let sql: string;

  if (categoryId) {
    sql = `
      WITH category_ids AS (
        SELECT DISTINCT cc.descendant_id
        FROM category_closure cc
        WHERE cc.ancestor_id = $3
      ),
      filtered_posts AS (
        SELECT bp.id AS post_id, bp.title AS post_title
        FROM blog_post bp
        WHERE bp.user_id = $1 AND bp.category_id IN (SELECT descendant_id FROM category_ids)
      )
      SELECT
        fp.post_id,
        fp.post_title,
        pc.content AS post_chunk,
        (0.7 * (1.0 - (pc.embedding <=> $2))) + (0.3 * (1.0 - (pte.embedding <=> $2))) AS similarity_score
      FROM filtered_posts fp
      JOIN post_chunks pc ON pc.post_id = fp.post_id
      JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
      WHERE (1.0 - (pc.embedding <=> $2)) > 0.2
      ORDER BY similarity_score DESC
      LIMIT 5;
    `;
    params.push(categoryId);
  } else {
    sql = `
      WITH filtered_posts AS (
        SELECT id AS post_id, title AS post_title
        FROM blog_post
        WHERE user_id = $1
      )
      SELECT
        fp.post_id,
        fp.post_title,
        pc.content AS post_chunk,
        (0.7 * (1.0 - (pc.embedding <=> $2))) + (0.3 * (1.0 - (pte.embedding <=> $2))) AS similarity_score
      FROM filtered_posts fp
      JOIN post_chunks pc ON pc.post_id = fp.post_id
      JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
      WHERE (1.0 - (pc.embedding <=> $2)) > 0.2
      ORDER BY similarity_score DESC
      LIMIT 5;
    `;
  }

  const { rows } = await pool.query(sql, params);

  return rows.map((row) => ({
    postId: row.post_id,
    postTitle: row.post_title,
    postChunk: row.post_chunk,
    similarityScore: row.similarity_score,
  }));
};

// ========= WRITE QUERIES =========
export const storeTitleEmbedding = async (postId: number, embedding: number[]) => {
  const pool = getDb();
  await pool.query(
    `INSERT INTO post_title_embeddings(post_id, embedding)
     VALUES ($1, $2)
     ON CONFLICT (post_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [postId, pgvector.toSql(embedding)]
  );
};

export const storeContentEmbeddings = async (
  postId: number,
  chunks: string[],
  embeddings: number[][]
) => {
  const pool = getDb();
  await pool.query('BEGIN');
  try {
    await pool.query('DELETE FROM post_chunks WHERE post_id = $1', [postId]);

    const query = `
      INSERT INTO post_chunks(post_id, chunk_index, content, embedding)
      SELECT x.post_id, x.chunk_index, x.content, x.embedding
      FROM UNNEST($1::bigint[], $2::int[], $3::text[], $4::vector[])
      AS x(post_id, chunk_index, content, embedding)
    `;

    const postIds = Array(chunks.length).fill(postId);
    const chunkIndexes = Array.from({ length: chunks.length }, (_, i) => i);
    const pgVectors = embeddings.map(pgvector.toSql);

    await pool.query(query, [postIds, chunkIndexes, chunks, pgVectors]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
};

// ========= READ QUERIES (V2 dynamic) =========
export const findSimilarChunksV2 = async (params: {
  userId: string;
  embedding: number[];
  categoryId?: number;
  from?: string; // ISO UTC
  to?: string;   // ISO UTC
  threshold?: number; // 0..1
  topK?: number; // default 5, max 10
  weights?: { chunk: number; title: number };
  sort?: 'created_at_desc' | 'created_at_asc';
}): Promise<SimilarChunk[]> => {
  const pool = getDb();
  const wChunk = Math.max(0, Math.min(1, params.weights?.chunk ?? 0.7));
  const wTitle = Math.max(0, Math.min(1, params.weights?.title ?? 0.3));
  const thr = params.threshold != null ? Math.max(0, Math.min(1, params.threshold)) : 0.2;
  const limit = Math.min(10, Math.max(1, params.topK ?? 5));

  const parts: string[] = [];
  const values: any[] = [];

  // $1: userId, $2: embedding
  values.push(params.userId);
  values.push(pgvector.toSql(params.embedding));

  const hasCategory = typeof params.categoryId === 'number';
  const hasTime = !!(params.from && params.to);

  if (hasCategory) {
    const catParam = values.length + 1; // next index
    parts.push(`
      WITH category_ids AS (
        SELECT DISTINCT cc.descendant_id
        FROM category_closure cc
        WHERE cc.ancestor_id = $${catParam}
      ),
      filtered_posts AS (
        SELECT bp.id AS post_id, bp.title AS post_title, bp.created_at
        FROM blog_post bp
        WHERE bp.user_id = $1 AND bp.category_id IN (SELECT descendant_id FROM category_ids)
      )`);
    values.push(params.categoryId);
  } else {
    parts.push(`
      WITH filtered_posts AS (
        SELECT id AS post_id, title AS post_title, created_at
        FROM blog_post
        WHERE user_id = $1
      )`);
  }

  // base select and threshold
  const thrParam = values.length + 1;
  parts.push(`
    SELECT
      fp.post_id,
      fp.post_title,
      pc.content AS post_chunk,
      (${wChunk} * (1.0 - (pc.embedding <=> $2))) + (${wTitle} * (1.0 - (pte.embedding <=> $2))) AS similarity_score,
      fp.created_at
    FROM filtered_posts fp
    JOIN post_chunks pc ON pc.post_id = fp.post_id
    JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
    WHERE (1.0 - (pc.embedding <=> $2)) > $${thrParam}
  `);
  values.push(thr);

  if (hasTime) {
    const fromParam = values.length + 1;
    const toParam = values.length + 2;
    parts.push(` AND fp.created_at BETWEEN $${fromParam} AND $${toParam}`);
    values.push(params.from, params.to);
  }

  let orderBy = 'similarity_score DESC';
  if (params.sort === 'created_at_desc') orderBy = 'similarity_score DESC, fp.created_at DESC';
  if (params.sort === 'created_at_asc') orderBy = 'similarity_score DESC, fp.created_at ASC';

  const limitParam = values.length + 1;
  parts.push(` ORDER BY ${orderBy} LIMIT $${limitParam}`);
  values.push(limit);

  const sql = parts.join('\n');

  const { rows } = await pool.query(sql, values);
  return rows.map((row) => ({
    postId: row.post_id,
    postTitle: row.post_title,
    postChunk: row.post_chunk,
    similarityScore: row.similarity_score,
  }));
};

export const textSearchChunksV2 = async (params: {
  userId: string;
  query?: string;
  keywords?: string[];
  categoryId?: number;
  from?: string;
  to?: string;
  topK?: number;
  sort?: 'created_at_desc' | 'created_at_asc';
}): Promise<TextSearchHit[]> => {
  const pool = getDb();
  const limit = Math.min(10, Math.max(1, params.topK ?? 5));

  const values: any[] = [];
  values.push(params.userId);

  const hasCategory = typeof params.categoryId === 'number';
  const hasTime = !!(params.from && params.to);
  const hasQuery = !!params.query && params.query.trim().length > 0;
  const keywords = (params.keywords || []).filter((k) => typeof k === 'string' && k.trim().length > 0);

  const withParts: string[] = [];
  if (hasCategory) {
    const catParam = values.length + 1;
    withParts.push(`
      category_ids AS (
        SELECT DISTINCT cc.descendant_id FROM category_closure cc WHERE cc.ancestor_id = $${catParam}
      ),
      filtered_posts AS (
        SELECT bp.id AS post_id, bp.title AS post_title, bp.created_at
        FROM blog_post bp
        WHERE bp.user_id = $1 AND bp.category_id IN (SELECT descendant_id FROM category_ids)
      )`);
    values.push(params.categoryId);
  } else {
    withParts.push(`
      filtered_posts AS (
        SELECT id AS post_id, title AS post_title, created_at
        FROM blog_post
        WHERE user_id = $1
      )`);
  }

  let base = `
    SELECT
      fp.post_id,
      fp.post_title,
      pc.content AS post_chunk,
      0::float8 AS content_sim,
      0::float8 AS title_sim,
      fp.created_at
    FROM filtered_posts fp
    JOIN post_chunks pc ON pc.post_id = fp.post_id
  `;
  if (hasQuery) {
    const qParam = values.length + 1;
    base = `
      SELECT
        fp.post_id,
        fp.post_title,
        pc.content AS post_chunk,
        COALESCE(similarity(pc.content, $${qParam}), 0) AS content_sim,
        COALESCE(similarity(fp.post_title, $${qParam}), 0) AS title_sim,
        fp.created_at
      FROM filtered_posts fp
      JOIN post_chunks pc ON pc.post_id = fp.post_id
    `;
    values.push(params.query);
  }

  const whereParts: string[] = [];
  if (hasTime) {
    const fromParam = values.length + 1;
    const toParam = values.length + 2;
    whereParts.push(`fp.created_at BETWEEN $${fromParam} AND $${toParam}`);
    values.push(params.from, params.to);
  }

  const likePatterns: string[] = [];
  for (const k of keywords) {
    likePatterns.push(`%${k}%`);
  }
  if (likePatterns.length > 0) {
    const arrParam = values.length + 1;
    whereParts.push(`(pc.content ILIKE ANY($${arrParam}) OR fp.post_title ILIKE ANY($${arrParam}))`);
    values.push(likePatterns);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  let orderBy = 'content_sim DESC';
  if (params.sort === 'created_at_desc') orderBy = 'content_sim DESC, fp.created_at DESC';
  if (params.sort === 'created_at_asc') orderBy = 'content_sim DESC, fp.created_at ASC';

  const limitParam = values.length + 1;
  const sql = `${withParts.length > 0 ? 'WITH ' + withParts.join(',\n') : ''}
${base}
${whereSql}
ORDER BY ${orderBy}
LIMIT $${limitParam}`;
  values.push(limit);

  const { rows } = await pool.query(sql, values);
  return rows.map((row) => ({
    postId: row.post_id,
    postTitle: row.post_title,
    postChunk: row.post_chunk,
    textScore: Math.max(Number(row.content_sim) || 0, Number(row.title_sim) || 0),
  }));
};
