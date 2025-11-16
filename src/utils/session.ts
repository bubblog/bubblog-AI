import * as sessionRepository from '../repositories/ask-session.repository';

export class SessionContextError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ResolveSessionOptions {
  requesterUserId: string;
  sessionId?: string | null;
  ownerUserId?: string | null;
  titleHint?: string;
}

export const resolveSessionContext = async ({
  requesterUserId,
  sessionId,
  ownerUserId,
  titleHint,
}: ResolveSessionOptions): Promise<{ session: sessionRepository.AskSession; created: boolean }> => {
  if (sessionId) {
    const numericId = Number(sessionId);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new SessionContextError(400, 'Invalid session_id');
    }
    const session = await sessionRepository.findSessionForRequester(numericId, requesterUserId);
    if (!session) {
      throw new SessionContextError(404, 'Session not found');
    }
    if (ownerUserId && ownerUserId !== session.ownerUserId) {
      throw new SessionContextError(409, 'Session owner mismatch');
    }
    return { session, created: false };
  }

  const trimmedOwner = ownerUserId?.trim();
  if (!trimmedOwner) {
    throw new SessionContextError(400, 'user_id is required when session_id is missing');
  }

  const normalizedTitle = titleHint?.trim();
  const title = normalizedTitle ? normalizedTitle.slice(0, 120) : null;

  const session = await sessionRepository.createSession({
    requesterUserId,
    ownerUserId: trimmedOwner,
    title,
  });

  return { session, created: true };
};
