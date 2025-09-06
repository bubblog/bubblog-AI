import { get_encoding } from '@dqbd/tiktoken';
import pgvector from 'pgvector/pg';
import { getDb } from '../utils/db';
import config from '../config';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;

/**
 * Splits a long text into smaller chunks based on token size.
 * @param content The text content to be split.
 * @returns An array of text chunks.
 */
export const chunkText = (content: string): string[] => {
  const tokenizer = get_encoding('cl100k_base');
  const sentences = content.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  const textDecoder = new TextDecoder();

  let currentChunk: number[] = [];

  for (const sentence of sentences) {
    const sentenceTokens = tokenizer.encode(sentence);
    if (currentChunk.length + sentenceTokens.length > CHUNK_SIZE) {
      const decodedBytes = tokenizer.decode(new Uint32Array(currentChunk));
      chunks.push(textDecoder.decode(decodedBytes));
      currentChunk = currentChunk.slice(currentChunk.length - CHUNK_OVERLAP);
    }
    currentChunk.push(...sentenceTokens);
  }

  if (currentChunk.length > 0) {
    const decodedBytes = tokenizer.decode(new Uint32Array(currentChunk));
    chunks.push(textDecoder.decode(decodedBytes));
  }

  return chunks;
};

/**
 * Creates vector embeddings for an array of texts.
 * @param texts The texts to be embedded.
 * @returns A promise that resolves to an array of embeddings.
 */
export const createEmbeddings = async (texts: string[]): Promise<number[][]> => {
  const response = await openai.embeddings.create({
    model: config.EMBED_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
};

/**
 * Stores the title embedding for a post.
 * @param postId The ID of the post.
 * @param title The title of the post.
 */
export const storeTitleEmbedding = async (postId: number, title: string) => {
  const [embedding] = await createEmbeddings([title]);
  const pool = getDb();

  await pool.query(
    `INSERT INTO post_title_embeddings(post_id, embedding)
     VALUES ($1, $2)
     ON CONFLICT (post_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [postId, pgvector.toSql(embedding)]
  );
};

/**
 * Stores the content embeddings for a post.
 * @param postId The ID of the post.
 * @param chunks The text chunks of the content.
 * @param embeddings The vector embeddings of the chunks.
 */
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

export interface Post {
  id: number;
  title: string;
  content: string;
  tags: string[];
  created_at: string;
  user_id: string;
}

/**
 * Finds a post by its ID.
 * @param postId The ID of the post to find.
 * @returns A promise that resolves to the post object or null if not found.
 */
export const findPostById = async (postId: number): Promise<Post | null> => {
  const pool = getDb();
  const { rows } = await pool.query(
    'SELECT id, title, content, tags, created_at, user_id FROM blog_post WHERE id = $1',
    [postId]
  );

  if (rows.length === 0) {
    return null;
  }

  return rows[0];
};
