import type { QueryExecutor } from '../utils/db';
import { runQuery } from '../utils/db';

export type MessageRole = 'user' | 'assistant';

export interface AskMessage {
  id: number;
  sessionId: number;
  role: MessageRole;
  content: string;
  searchPlan: Record<string, unknown> | null;
  retrievalMeta: Record<string, unknown> | null;
  createdAt: Date;
}

type MessageRow = {
  id: number;
  sessionId: number;
  role: MessageRole;
  content: string;
  searchPlan: Record<string, unknown> | null;
  retrievalMeta: Record<string, unknown> | null;
  createdAt: Date;
};

const baseSelect = `
  SELECT
    id,
    session_id AS "sessionId",
    role,
    content,
    search_plan AS "searchPlan",
    retrieval_meta AS "retrievalMeta",
    created_at AS "createdAt"
  FROM ask_message
`;

const mapMessage = (row: MessageRow): AskMessage => ({
  ...row,
  searchPlan: row.searchPlan ?? null,
  retrievalMeta: row.retrievalMeta ?? null,
});

export const insertMessage = async (
  params: {
    sessionId: number;
    role: MessageRole;
    content: string;
    searchPlan?: Record<string, unknown> | null;
    retrievalMeta?: Record<string, unknown> | null;
  },
  executor?: QueryExecutor
): Promise<AskMessage> => {
  const result = await runQuery<MessageRow>(
    `
      INSERT INTO ask_message (session_id, role, content, search_plan, retrieval_meta)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        session_id AS "sessionId",
        role,
        content,
        search_plan AS "searchPlan",
        retrieval_meta AS "retrievalMeta",
        created_at AS "createdAt"
    `,
    [params.sessionId, params.role, params.content, params.searchPlan ?? null, params.retrievalMeta ?? null],
    executor
  );

  return mapMessage(result.rows[0]);
};

export const getMessageById = async (messageId: number): Promise<AskMessage | null> => {
  const result = await runQuery<MessageRow>(`${baseSelect} WHERE id = $1`, [messageId]);
  if (!result.rowCount) return null;
  return mapMessage(result.rows[0]);
};

export const getLatestMessages = async (
  sessionId: number,
  limit = 4,
  executor?: QueryExecutor
): Promise<AskMessage[]> => {
  const result = await runQuery<MessageRow>(
    `${baseSelect} WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [sessionId, limit],
    executor
  );
  return result.rows.map(mapMessage).reverse();
};

export type MessageDirection = 'forward' | 'backward';

export interface FetchMessagesParams {
  sessionId: number;
  limit: number;
  direction?: MessageDirection;
  cursor?: { createdAt: Date; id: number };
}

export const getMessagesBySession = async ({
  sessionId,
  limit,
  direction = 'backward',
  cursor,
}: FetchMessagesParams): Promise<AskMessage[]> => {
  const predicates = ['session_id = $1'];
  const values: unknown[] = [sessionId];

  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    const cursorCreatedIdx = values.length - 1;
    const cursorIdIdx = values.length;

    if (direction === 'forward') {
      predicates.push(
        `(created_at > $${cursorCreatedIdx} OR (created_at = $${cursorCreatedIdx} AND id > $${cursorIdIdx}))`
      );
    } else {
      predicates.push(
        `(created_at < $${cursorCreatedIdx} OR (created_at = $${cursorCreatedIdx} AND id < $${cursorIdIdx}))`
      );
    }
  }

  values.push(limit);
  const limitIdx = values.length;

  const orderClause = direction === 'forward' ? 'ORDER BY created_at ASC, id ASC' : 'ORDER BY created_at DESC, id DESC';

  const result = await runQuery<MessageRow>(
    `${baseSelect} WHERE ${predicates.join(' AND ')} ${orderClause} LIMIT $${limitIdx}`,
    values
  );

  const mapped = result.rows.map(mapMessage);
  return direction === 'forward' ? mapped : mapped.reverse();
};

export const countMessagesForSession = async (sessionId: number): Promise<number> => {
  const result = await runQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM ask_message WHERE session_id = $1', [
    sessionId,
  ]);
  return Number(result.rows[0]?.count ?? 0);
};
