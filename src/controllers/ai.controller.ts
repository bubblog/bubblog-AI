import { Request, Response, NextFunction } from 'express';
import {
  chunkText,
  createEmbeddings,
  storeTitleEmbedding,
  storeContentEmbeddings,
} from '../services/embedding.service';
import { answerStream } from '../services/qa.service';
import { EmbedTitleRequest, EmbedContentRequest, AskRequest } from '../types/ai.types';

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
    const { question, user_id, category_id, speech_tone, post_id } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await answerStream(question, user_id, category_id, speech_tone, post_id);
    stream.pipe(res);

  } catch (error) {
    next(error);
  }
};
