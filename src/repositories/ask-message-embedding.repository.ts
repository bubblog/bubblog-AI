import pgvector from 'pgvector/pg';
import type { QueryExecutor } from '../utils/db';
import { runQuery } from '../utils/db';

export interface MessageEmbedding {
  messageId: number;
  ownerUserId: string;
  requesterUserId: string;
  categoryId: number | null;
  postId: number | null;
  answerMessageId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type EmbeddingRow = {
  messageId: number;
  ownerUserId: string;
  requesterUserId: string;
  categoryId: number | null;
  postId: number | null;
  answerMessageId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

const baseSelect = `
  SELECT
    message_id AS "messageId",
    owner_user_id AS "ownerUserId",
    requester_user_id AS "requesterUserId",
    category_id AS "categoryId",
    post_id AS "postId",
    answer_message_id AS "answerMessageId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  FROM ask_message_embedding
`;

const mapRow = (row: EmbeddingRow): MessageEmbedding => ({ ...row });

export const upsertEmbedding = async (
  params: {
    messageId: number;
    ownerUserId: string;
    requesterUserId: string;
    embedding: number[];
    categoryId?: number | null;
    postId?: number | null;
    answerMessageId?: number | null;
  },
  executor?: QueryExecutor
): Promise<MessageEmbedding> => {
  const result = await runQuery<EmbeddingRow>(
    `
      INSERT INTO ask_message_embedding (
        message_id,
        owner_user_id,
        requester_user_id,
        category_id,
        post_id,
        answer_message_id,
        embedding
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (message_id) DO UPDATE
      SET
        category_id = EXCLUDED.category_id,
        post_id = EXCLUDED.post_id,
        answer_message_id = EXCLUDED.answer_message_id,
        embedding = EXCLUDED.embedding,
        updated_at = now()
      RETURNING
        message_id AS "messageId",
        owner_user_id AS "ownerUserId",
        requester_user_id AS "requesterUserId",
        category_id AS "categoryId",
        post_id AS "postId",
        answer_message_id AS "answerMessageId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [
      params.messageId,
      params.ownerUserId,
      params.requesterUserId,
      params.categoryId ?? null,
      params.postId ?? null,
      params.answerMessageId ?? null,
      pgvector.toSql(params.embedding),
    ],
    executor
  );

  return mapRow(result.rows[0]);
};

export interface SimilarMessage {
  messageId: number;
  answerMessageId: number | null;
  similarity: number;
}

export interface SimilarSearchParams {
  ownerUserId: string;
  requesterUserId: string;
  embedding: number[];
  postId?: number | null;
  categoryId?: number | null;
  limit?: number;
}

export const findSimilarEmbeddings = async ({
  ownerUserId,
  requesterUserId,
  embedding,
  postId,
  categoryId,
  limit = 3,
}: SimilarSearchParams): Promise<SimilarMessage[]> => {
  const filters = ['owner_user_id = $2', 'requester_user_id = $3'];
  const values: unknown[] = [pgvector.toSql(embedding), ownerUserId, requesterUserId];

  if (postId != null) {
    values.push(postId);
    filters.push('post_id = $' + values.length);
  } else {
    filters.push('post_id IS NULL');
  }

  if (postId == null) {
    values.push(categoryId ?? null);
    filters.push('category_id IS NOT DISTINCT FROM $' + values.length);
  }

  values.push(limit);
  const limitIdx = values.length;

  const result = await runQuery<SimilarMessage>(
    `
      SELECT
        message_id AS "messageId",
        answer_message_id AS "answerMessageId",
        1 - (embedding <=> $1) AS similarity
      FROM ask_message_embedding
      WHERE ${filters.join(' AND ')}
      ORDER BY embedding <-> $1
      LIMIT $${limitIdx}
    `,
    values
  );

  return result.rows;
};

export const deleteEmbeddingsByOwner = async (ownerUserId: string): Promise<number> => {
  const result = await runQuery('DELETE FROM ask_message_embedding WHERE owner_user_id = $1', [ownerUserId]);
  return result.rowCount ?? 0;
};
