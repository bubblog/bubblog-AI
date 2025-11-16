import { runQuery, QueryExecutor } from '../utils/db';

export type JsonMap = Record<string, unknown>;

export interface AskSession {
  id: number;
  requesterUserId: string;
  ownerUserId: string;
  title: string | null;
  metadata: JsonMap;
  lastQuestionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AskSessionSummary extends AskSession {
  messageCount: number;
}

type AskSessionRow = {
  id: number;
  requesterUserId: string;
  ownerUserId: string;
  title: string | null;
  metadata: JsonMap | null;
  lastQuestionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
};

const baseSelect = `
  SELECT
    s.id,
    s.requester_user_id AS "requesterUserId",
    s.owner_user_id AS "ownerUserId",
    s.title,
    s.metadata,
    s.last_question_at AS "lastQuestionAt",
    s.created_at AS "createdAt",
    s.updated_at AS "updatedAt"
  FROM ask_session s
`;

const mapRow = <T extends AskSessionRow>(row: T): T & { metadata: JsonMap } => ({
  ...row,
  metadata: row.metadata ?? {},
});

export const createSession = async (params: {
  requesterUserId: string;
  ownerUserId: string;
  title?: string | null;
  metadata?: JsonMap;
}): Promise<AskSession> => {
  const result = await runQuery<AskSessionRow>(
    `
      INSERT INTO ask_session (requester_user_id, owner_user_id, title, metadata)
      VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
      RETURNING
        id,
        requester_user_id AS "requesterUserId",
        owner_user_id AS "ownerUserId",
        title,
        metadata,
        last_question_at AS "lastQuestionAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    [params.requesterUserId, params.ownerUserId, params.title ?? null, JSON.stringify(params.metadata ?? {})]
  );

  return mapRow(result.rows[0]);
};

export const findSessionById = async (sessionId: number): Promise<AskSession | null> => {
  const result = await runQuery<AskSessionRow>(`${baseSelect} WHERE s.id = $1`, [sessionId]);
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
};

export const findSessionForRequester = async (
  sessionId: number,
  requesterUserId: string
): Promise<AskSession | null> => {
  const result = await runQuery<AskSessionRow>(`${baseSelect} WHERE s.id = $1 AND s.requester_user_id = $2`, [
    sessionId,
    requesterUserId,
  ]);
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
};

export interface ListSessionsParams {
  requesterUserId: string;
  ownerUserId?: string;
  cursorCreatedAt?: Date;
  cursorId?: number;
  limit?: number;
}

export const listSessionsForRequester = async ({
  requesterUserId,
  ownerUserId,
  cursorCreatedAt,
  cursorId,
  limit = 20,
}: ListSessionsParams): Promise<AskSessionSummary[]> => {
  const conditions = ['s.requester_user_id = $1'];
  const values: unknown[] = [requesterUserId];
  let paramIndex = values.length;

  if (ownerUserId) {
    values.push(ownerUserId);
    paramIndex += 1;
    conditions.push(`s.owner_user_id = $${paramIndex}`);
  }

  if (cursorCreatedAt && cursorId) {
    values.push(cursorCreatedAt, cursorId);
    const cursorCreatedIdx = values.length - 1;
    const cursorIdIdx = values.length;
    conditions.push(
      `(s.created_at < $${cursorCreatedIdx} OR (s.created_at = $${cursorCreatedIdx} AND s.id < $${cursorIdIdx}))`
    );
  }

  values.push(limit);
  const limitIdx = values.length;

  const sql = `
    SELECT
      s.id,
      s.requester_user_id AS "requesterUserId",
      s.owner_user_id AS "ownerUserId",
      s.title,
      s.metadata,
      s.last_question_at AS "lastQuestionAt",
      s.created_at AS "createdAt",
      s.updated_at AS "updatedAt",
      COALESCE(stats.message_count, 0)::int AS "messageCount"
    FROM ask_session s
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS message_count
      FROM ask_message m
      WHERE m.session_id = s.id
    ) AS stats ON true
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT $${limitIdx}
  `;

  const result = await runQuery<AskSessionRow & { messageCount: number }>(sql, values);
  return result.rows.map((row) => mapRow(row));
};

export const updateSessionMeta = async (
  sessionId: number,
  requesterUserId: string,
  updates: { title?: string | null; metadata?: JsonMap }
): Promise<AskSession | null> => {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    values.push(updates.title ?? null);
    sets.push(`title = $${values.length}`);
  }

  if (updates.metadata !== undefined) {
    values.push(JSON.stringify(updates.metadata ?? {}));
    sets.push(`metadata = COALESCE($${values.length}::jsonb, '{}'::jsonb)`);
  }

  if (sets.length === 1) {
    return findSessionForRequester(sessionId, requesterUserId);
  }

  values.push(sessionId, requesterUserId);
  const sessionIdx = values.length - 1;
  const requesterIdx = values.length;

  const result = await runQuery<AskSessionRow>(
    `
      UPDATE ask_session
      SET ${sets.join(', ')}
      WHERE id = $${sessionIdx} AND requester_user_id = $${requesterIdx}
      RETURNING
        id,
        requester_user_id AS "requesterUserId",
        owner_user_id AS "ownerUserId",
        title,
        metadata,
        last_question_at AS "lastQuestionAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
    values
  );

  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
};

export const touchSessionLastQuestion = async (sessionId: number, executor?: QueryExecutor): Promise<void> => {
  await runQuery('UPDATE ask_session SET last_question_at = now(), updated_at = now() WHERE id = $1', [sessionId], executor);
};

export const deleteSession = async (sessionId: number, requesterUserId: string): Promise<boolean> => {
  const result = await runQuery('DELETE FROM ask_session WHERE id = $1 AND requester_user_id = $2', [
    sessionId,
    requesterUserId,
  ]);
  return (result.rowCount ?? 0) > 0;
};
