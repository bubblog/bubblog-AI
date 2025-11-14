import { Request, Response, NextFunction } from 'express';
import { AskV2Request } from '../types/ai.v2.types';
import { answerStreamV2 } from '../services/qa.v2.service';
import { AuthRequest } from '../middlewares/auth.middleware';
import { extractRequesterId } from '../utils/auth';
import { resolveSessionContext, SessionContextError } from '../utils/session';

export const askV2Handler = async (
  req: AuthRequest & Request<{}, {}, AskV2Request>,
  res: Response,
  next: NextFunction
) => {
  // 검색 계획 기반 v2 QA를 SSE로 중계
  try {
    const requesterUserId = extractRequesterId(req);
    if (!requesterUserId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { question, user_id, session_id, category_id, speech_tone, post_id, llm } = req.body;

    let sessionResult;
    try {
      sessionResult = await resolveSessionContext({
        requesterUserId,
        sessionId: session_id,
        ownerUserId: user_id,
        titleHint: question,
      });
    } catch (error) {
      if (error instanceof SessionContextError) {
        return res.status(error.status).json({ message: error.message });
      }
      throw error;
    }

    const { session, created } = sessionResult;
    const ownerUserId = session.ownerUserId;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('session-id', String(session.id));
    (res as any).flushHeaders?.();
    (res.socket as any)?.setNoDelay?.(true);
    res.write(':ok\n\n');

    if (created) {
      const payload = {
        session_id: String(session.id),
        owner_user_id: ownerUserId,
        requester_user_id: requesterUserId,
      };
      res.write(`event: session\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    const stream = await answerStreamV2(
      question,
      ownerUserId,
      category_id,
      speech_tone,
      post_id,
      llm
    );

    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      res.write(buf);
      (res as any).flush?.();
    });
    stream.on('end', () => res.end());
    stream.on('error', () => res.end());

    req.on('close', () => {
      try {
        stream.destroy();
      } catch {}
    });
  } catch (error) {
    next(error);
  }
};
