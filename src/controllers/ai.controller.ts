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

export const embedTitleHandler = async (
  req: Request<{}, {}, EmbedTitleRequest>,
  res: Response,
  next: NextFunction
) => {
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
  req: Request<{}, {}, AskRequest>,
  res: Response,
  next: NextFunction
) => {
  try {
    const { question, user_id, category_id, speech_tone, post_id, llm } = req.body as any;

    // SSE headers and anti-buffering hints
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Nginx buffering off
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers early so clients start processing immediately
    (res as any).flushHeaders?.();
    // Reduce Nagle’s algorithm buffering on the socket for faster flush
    (res.socket as any)?.setNoDelay?.(true);
    // Prime the SSE stream to break proxy buffering thresholds
    res.write(':ok\n\n');

    const stream = await answerStream(question, user_id, category_id, speech_tone, post_id, llm);
    // Manually bridge to ensure flushing of SSE deltas
    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      res.write(buf);
      const canFlush = typeof (res as any).flush === 'function';
      // try to flush if supported by runtime/middleware
      (res as any).flush?.();
      DebugLogger.log('sse', { type: 'debug.sse.write', at: Date.now(), bytes: buf.length, flushed: canFlush });
    });
    stream.on('end', () => {
      res.end();
    });
    stream.on('error', () => {
      res.end();
    });

    // Cleanup if client disconnects
    req.on('close', () => {
      try {
        stream.destroy();
      } catch {}
    });

  } catch (error) {
    next(error);
  }
};
