import { Request, Response, NextFunction } from 'express';
import { AskV2Request } from '../types/ai.v2.types';
import { answerStreamV2 } from '../services/qa.v2.service';

export const askV2Handler = async (
  req: Request<{}, {}, AskV2Request>,
  res: Response,
  next: NextFunction
) => {
  try {
    const { question, user_id, category_id, speech_tone, post_id, llm } = req.body as any;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await answerStreamV2(
      question,
      user_id,
      category_id,
      speech_tone,
      post_id,
      llm
    );
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
};

