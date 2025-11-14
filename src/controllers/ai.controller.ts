import { Request, Response, NextFunction } from 'express';
import {
  chunkText,
  createEmbeddings,
  storeTitleEmbedding,
  storeContentEmbeddings,
} from '../services/embedding.service';
import { answerStream } from '../services/qa.service';
import { EmbedTitleRequest, EmbedContentRequest, AskRequest } from '../types/ai.types';
import { DebugLogger } from '../utils/debug-logger';
import { AuthRequest } from '../middlewares/auth.middleware';
import { extractRequesterId } from '../utils/auth';
import { resolveSessionContext, SessionContextError } from '../utils/session';

export const embedTitleHandler = async (
  req: Request<{}, {}, EmbedTitleRequest>,
  res: Response,
  next: NextFunction
) => {
  // 포스트 제목 임베딩을 생성하고 저장
  try {
    const { post_id, title } = req.body;
    await storeTitleEmbedding(post_id, title);
    res.status(200).json({ ok: true });
  } catch (error) {
    next(error);
  }
};

export const embedContentHandler = async (
  req: Request<{}, {}, EmbedContentRequest>,
  res: Response,
  next: NextFunction
) => {
  // 본문을 청크 단위로 임베딩 생성 후 DB에 반영
  try {
    const { post_id, content } = req.body;
    const chunks = chunkText(content);
    const embeddings = await createEmbeddings(chunks);
    await storeContentEmbeddings(post_id, chunks, embeddings);

    res.status(200).json({
      post_id: post_id,
      chunk_count: chunks.length,
      success: true,
    });
  } catch (error) {
    next(error);
  }
};

export const askHandler = async (
  req: AuthRequest & Request<{}, {}, AskRequest>,
  res: Response,
  next: NextFunction
) => {
  // RAG 기반 QA 결과를 SSE 스트림으로 클라이언트에 전달
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

    // SSE를 위한 헤더 설정과 버퍼링 완화 옵션
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx 버퍼링 비활성화
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('session-id', String(session.id));
    // 헤더를 먼저 전송해 클라이언트 처리를 즉시 시작
    (res as any).flushHeaders?.();
    // 소켓의 네이글 알고리즘 버퍼링을 줄여 전송 지연 완화
    (res.socket as any)?.setNoDelay?.(true);
    // 프록시 버퍼링 임계값을 넘기기 위한 초기 keep-alive 전송
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

    const stream = await answerStream({
      question,
      session,
      requesterUserId,
      ownerUserId,
      categoryId: category_id,
      speechTone: speech_tone,
      postId: post_id,
      llm,
    });

    stream.on('session_saved', (payload) => {
      res.write(`event: session_saved\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    stream.on('session_error', (payload) => {
      res.write(`event: session_error\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    // SSE 델타가 즉시 전송되도록 수동 브리징
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      res.write(buf);
      const canFlush = typeof (res as any).flush === 'function';
      // 런타임 또는 미들웨어가 지원하면 즉시 플러시
      (res as any).flush?.();
      DebugLogger.log('sse', { type: 'debug.sse.write', at: Date.now(), bytes: buf.length, flushed: canFlush });
    });
    stream.on('end', () => {
      res.end();
    });
    stream.on('error', () => {
      res.end();
    });

    // 클라이언트 연결이 끊기면 스트림 자원 해제
    req.on('close', () => {
      try {
        stream.emit('client_disconnect');
        stream.destroy();
      } catch {}
    });

  } catch (error) {
    next(error);
  }
};
