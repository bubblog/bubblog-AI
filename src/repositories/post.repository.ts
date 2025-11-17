import pgvector from 'pgvector/pg';
import { getDb } from '../utils/db';

// ========= 인터페이스 정의 =========
export interface Post {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  user_id: string;
  is_public:boolean;
}

export interface SimilarChunk {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
  chunkIndex?: number;
  postCreatedAt?: string;
  postTags?: string[];
}

export interface TextSearchHit {
  postId: string;
  postTitle: string;
  postChunk: string;
  textScore: number;
  chunkIndex?: number;
  postCreatedAt?: string;
  postTags?: string[];
}

export interface TextSearchHit {
  postId: string;
  postTitle: string;
  postChunk: string;
  textScore: number;
}

// ========= 조회 쿼리 =========
// 포스트 ID로 본문과 메타데이터를 조회
export const findPostById = async (postId: number): Promise<Post | null> => {
  const pool = getDb();
  // 일부 데이터베이스에는 blog_post 테이블에 `tags` 컬럼이 없을 수 있음
  // 존재하는 컬럼만 조회하고 `tags`는 빈 배열로 대체해 안정성을 확보
  const { rows } = await pool.query(
    'SELECT id, title, content, created_at, user_id, is_public FROM blog_post WHERE id = $1',
    [postId]
  );
  if (rows.length === 0) return null;

  const row = rows[0] as any;
  const post: Post = {
    id: row.id,
    title: row.title,
    content: row.content,
    // DB에 tags 컬럼이 없을 경우 프롬프트가 자연스럽도록 빈 배열 유지
    tags: Array.isArray(row.tags) ? row.tags : [],
    created_at: row.created_at,
    user_id: row.user_id,
    is_public: row.is_public,
  };
  return post;
};

// 기본 RAG 경로에서 사용할 상위 유사 청크를 조회
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

// ========= 쓰기 쿼리 =========
// 제목 임베딩을 upsert로 저장
export const storeTitleEmbedding = async (postId: number, embedding: number[]) => {
  const pool = getDb();
  await pool.query(
    `INSERT INTO post_title_embeddings(post_id, embedding)
     VALUES ($1, $2)
     ON CONFLICT (post_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [postId, pgvector.toSql(embedding)]
  );
};

// 본문 청크 임베딩을 트랜잭션으로 갱신
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

// ========= 조회 쿼리 (V2 동적) =========
// v2 검색 계획 파라미터에 맞춰 유사 청크를 조회
export const findSimilarChunksV2 = async (params: {
  userId: string;
  embedding: number[];
  categoryId?: number;
  from?: string; // ISO UTC 문자열
  to?: string;   // ISO UTC 문자열
  threshold?: number; // 0..1 범위
  topK?: number; // 기본 5, 최대 10
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

  // $1은 userId, $2는 embedding
  values.push(params.userId);
  values.push(pgvector.toSql(params.embedding));

  const hasCategory = typeof params.categoryId === 'number';
  const hasTime = !!(params.from && params.to);

  if (hasCategory) {
    const catParam = values.length + 1; // 다음 플레이스홀더 인덱스
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

  // 기본 SELECT 구문과 임계값 조건
  const thrParam = values.length + 1;
  parts.push(`
    SELECT
      fp.post_id,
      fp.post_title,
      pc.content AS post_chunk,
      pc.chunk_index AS chunk_index,
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
    chunkIndex: row.chunk_index,
    postCreatedAt: row.created_at,
    postTags: [],
  }));
};

// 키워드와 텍스트 유사도 기반 검색 결과를 조회
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
      pc.chunk_index AS chunk_index,
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
        pc.chunk_index AS chunk_index,
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
    chunkIndex: row.chunk_index,
    postCreatedAt: row.created_at,
    postTags: [],
  }));
};

// ========= 글로벌 쿼리 (사용자·카테고리 제한 없음) =========
// 전체 블로그 데이터를 대상으로 ANN 기반 유사 청크 조회
export const findSimilarChunksGlobalANN = async (params: {
  embedding: number[];
  threshold?: number; // 청크 유사도에만 적용되는 임계값
  topK?: number; // 최종 반환할 개수
  weights?: { chunk: number; title: number };
  sort?: 'created_at_desc' | 'created_at_asc';
  annFactor?: number; // 초기 ANN 후보 개수에 곱할 배수
}): Promise<SimilarChunk[]> => {
  const pool = getDb();
  const wChunk = Math.max(0, Math.min(1, params.weights?.chunk ?? 0.7));
  const wTitle = Math.max(0, Math.min(1, params.weights?.title ?? 0.3));
  const thr = params.threshold != null ? Math.max(0, Math.min(1, params.threshold)) : 0.2;
  const topK = Math.min(50, Math.max(1, params.topK ?? 5));
  const factor = Math.min(20, Math.max(1, params.annFactor ?? 5));
  const annLimit = Math.min(500, topK * factor);

  const values: any[] = [];
  values.push(pgvector.toSql(params.embedding)); // $1

  const thrParam = values.length + 1; // $2
  values.push(thr);

  const annLimitParam = values.length + 1; // $3
  values.push(annLimit);

  const topKParam = values.length + 1; // $4
  values.push(topK);

  let orderBy = 'similarity_score DESC';
  if (params.sort === 'created_at_desc') orderBy = 'similarity_score DESC, created_at DESC';
  if (params.sort === 'created_at_asc') orderBy = 'similarity_score DESC, created_at ASC';

  const sql = `
    WITH nn AS (
      SELECT pc.post_id, pc.chunk_index, pc.content, (pc.embedding <=> $1) AS dist
      FROM post_chunks pc
      ORDER BY pc.embedding <=> $1
      LIMIT $${annLimitParam}
    ),
    scored AS (
      SELECT
        nn.post_id,
        bp.title AS post_title,
        nn.content AS post_chunk,
        nn.chunk_index,
        (${wChunk} * (1.0 - nn.dist)) + (${wTitle} * (1.0 - (pte.embedding <=> $1))) AS similarity_score,
        bp.created_at
      FROM nn
      JOIN blog_post bp ON bp.id = nn.post_id
      JOIN post_title_embeddings pte ON pte.post_id = nn.post_id
      WHERE (1.0 - nn.dist) > $${thrParam}
    )
    SELECT * FROM scored
    ORDER BY ${orderBy}
    LIMIT $${topKParam}
  `;

  const { rows } = await pool.query(sql, values);
  return rows.map((row) => ({
    postId: row.post_id,
    postTitle: row.post_title,
    postChunk: row.post_chunk,
    similarityScore: row.similarity_score,
    chunkIndex: row.chunk_index,
    postCreatedAt: row.created_at,
    postTags: [],
  }));
};

// 전역 텍스트 검색으로 하이브리드 보조 후보를 수집
export const textSearchChunksGlobal = async (params: {
  query?: string;
  keywords?: string[];
  topK?: number;
  sort?: 'created_at_desc' | 'created_at_asc';
}): Promise<TextSearchHit[]> => {
  const pool = getDb();
  const limit = Math.min(50, Math.max(1, params.topK ?? 5));

  const values: any[] = [];

  const hasQuery = !!params.query && params.query.trim().length > 0;
  const keywords = (params.keywords || []).filter((k) => typeof k === 'string' && k.trim().length > 0);

  let base = `
    SELECT
      bp.id AS post_id,
      bp.title AS post_title,
      pc.content AS post_chunk,
      0::float8 AS content_sim,
      0::float8 AS title_sim,
      bp.created_at
    FROM blog_post bp
    JOIN post_chunks pc ON pc.post_id = bp.id
  `;
  if (hasQuery) {
    const qParam = values.length + 1;
    base = `
      SELECT
        bp.id AS post_id,
        bp.title AS post_title,
        pc.content AS post_chunk,
        COALESCE(similarity(pc.content, $${qParam}), 0) AS content_sim,
        COALESCE(similarity(bp.title, $${qParam}), 0) AS title_sim,
        bp.created_at
      FROM blog_post bp
      JOIN post_chunks pc ON pc.post_id = bp.id
    `;
    values.push(params.query);
  }

  const whereParts: string[] = [];

  const likePatterns: string[] = [];
  for (const k of keywords) {
    likePatterns.push(`%${k}%`);
  }
  if (likePatterns.length > 0) {
    const arrParam = values.length + 1;
    whereParts.push(`(pc.content ILIKE ANY($${arrParam}) OR bp.title ILIKE ANY($${arrParam}))`);
    values.push(likePatterns);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  let orderBy = 'content_sim DESC';
  if (params.sort === 'created_at_desc') orderBy = 'content_sim DESC, bp.created_at DESC';
  if (params.sort === 'created_at_asc') orderBy = 'content_sim DESC, bp.created_at ASC';

  const limitParam = values.length + 1;
  const sql = `${base}
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
    chunkIndex: undefined,
    postCreatedAt: row.created_at,
    postTags: [],
  }));
};
