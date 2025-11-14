import { Request, Response } from 'express';
import { AuthRequest } from '../middlewares/auth.middleware';
import * as sessionRepository from '../repositories/ask-session.repository';
import * as messageRepository from '../repositories/ask-message.repository';
import { sessionListQuerySchema, sessionMessagesQuerySchema, sessionPatchSchema } from '../types/session.types';

const encodeCursor = (createdAt: Date, id: number): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');

const decodeCursor = (cursor: string): { createdAt: Date; id: number } | null => {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    const [iso, idStr] = decoded.split('|');
    if (!iso || !idStr) return null;
    const createdAt = new Date(iso);
    const id = Number(idStr);
    if (Number.isNaN(createdAt.getTime()) || !Number.isFinite(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
};

const resolveRequesterId = (req: AuthRequest): string | null => {
  const user = req.user;
  if (!user || typeof user !== 'object') return null;
  const candidate = (user as Record<string, unknown>).user_id ?? (user as Record<string, unknown>).sub;
  return typeof candidate === 'string' ? candidate : null;
};

const toSessionResponse = (
  session: sessionRepository.AskSession | sessionRepository.AskSessionSummary,
  messageCountOverride?: number
) => ({
  session_id: session.id,
  owner_user_id: session.ownerUserId,
  requester_user_id: session.requesterUserId,
  title: session.title,
  metadata: session.metadata ?? {},
  last_question_at: session.lastQuestionAt ? session.lastQuestionAt.toISOString() : null,
  created_at: session.createdAt.toISOString(),
  updated_at: session.updatedAt.toISOString(),
  message_count:
    messageCountOverride ?? ('messageCount' in session ? session.messageCount : undefined),
});

const toMessageResponse = (message: messageRepository.AskMessage) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  search_plan: message.searchPlan,
  retrieval_meta: message.retrievalMeta,
  created_at: message.createdAt.toISOString(),
});

export const listSessionsHandler = async (req: AuthRequest, res: Response) => {
  const requesterId = resolveRequesterId(req);
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  const parse = sessionListQuerySchema.safeParse(req.query);
  if (!parse.success) return res.status(400).json({ message: 'Invalid query', issues: parse.error.format() });
  const { limit, cursor, owner_user_id: ownerUserId } = parse.data;

  let cursorPayload: { createdAt: Date; id: number } | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return res.status(400).json({ message: 'Invalid cursor' });
    cursorPayload = decoded;
  }

  const sessions = await sessionRepository.listSessionsForRequester({
    requesterUserId: requesterId,
    ownerUserId,
    cursorCreatedAt: cursorPayload?.createdAt,
    cursorId: cursorPayload?.id,
    limit,
  });

  const hasMore = sessions.length === limit;
  const nextCursor =
    hasMore && sessions.length
      ? encodeCursor(sessions[sessions.length - 1].createdAt, sessions[sessions.length - 1].id)
      : null;

  res.json({
    sessions: sessions.map((session) => toSessionResponse(session)),
    paging: { cursor: nextCursor, has_more: hasMore },
  });
};

export const getSessionHandler = async (req: AuthRequest, res: Response) => {
  const requesterId = resolveRequesterId(req);
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ message: 'Invalid session id' });

  const session = await sessionRepository.findSessionForRequester(sessionId, requesterId);
  if (!session) return res.status(404).json({ message: 'Session not found' });

  const messageCount = await messageRepository.countMessagesForSession(sessionId);

  res.json(toSessionResponse(session, messageCount));
};

export const getSessionMessagesHandler = async (req: AuthRequest, res: Response) => {
  const requesterId = resolveRequesterId(req);
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ message: 'Invalid session id' });

  const session = await sessionRepository.findSessionForRequester(sessionId, requesterId);
  if (!session) return res.status(404).json({ message: 'Session not found' });

  const parse = sessionMessagesQuerySchema.safeParse(req.query);
  if (!parse.success) return res.status(400).json({ message: 'Invalid query', issues: parse.error.format() });

  const { limit, cursor, direction } = parse.data;
  let cursorPayload: { createdAt: Date; id: number } | undefined;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return res.status(400).json({ message: 'Invalid cursor' });
    cursorPayload = decoded;
  }

  const messages = await messageRepository.getMessagesBySession({
    sessionId,
    limit,
    direction,
    cursor: cursorPayload ? { createdAt: cursorPayload.createdAt, id: cursorPayload.id } : undefined,
  });

  const hasMore = messages.length === limit;
  const nextCursor =
    hasMore && messages.length
      ? encodeCursor(messages[messages.length - 1].createdAt, messages[messages.length - 1].id)
      : null;

  res.json({
    session_id: session.id,
    owner_user_id: session.ownerUserId,
    requester_user_id: session.requesterUserId,
    messages: messages.map(toMessageResponse),
    paging: { direction, has_more: hasMore, next_cursor: nextCursor },
  });
};

export const patchSessionHandler = async (req: AuthRequest, res: Response) => {
  const requesterId = resolveRequesterId(req);
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ message: 'Invalid session id' });

  const parse = sessionPatchSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ message: 'Invalid body', issues: parse.error.format() });

  const updates = parse.data;
  if (!('title' in updates) && !('metadata' in updates))
    return res.status(400).json({ message: 'No fields to update' });

  const updated = await sessionRepository.updateSessionMeta(sessionId, requesterId, updates);
  if (!updated) return res.status(404).json({ message: 'Session not found' });

  res.json(toSessionResponse(updated));
};

export const deleteSessionHandler = async (req: AuthRequest, res: Response) => {
  const requesterId = resolveRequesterId(req);
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) return res.status(400).json({ message: 'Invalid session id' });

  const deleted = await sessionRepository.deleteSession(sessionId, requesterId);
  if (!deleted) return res.status(404).json({ message: 'Session not found' });

  res.json({ session_id: sessionId, deleted: true });
};
