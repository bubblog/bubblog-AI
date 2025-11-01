import { Router } from 'express';
import {
  embedTitleHandler,
  embedContentHandler,
  askHandler,
} from '../controllers/ai.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

// AI 관련 1세대 엔드포인트를 정의
const aiRouter = Router();

aiRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

aiRouter.post('/embeddings/title', embedTitleHandler);
aiRouter.post('/embeddings/content', embedContentHandler);
aiRouter.post('/ask', authMiddleware, askHandler);

export default aiRouter;
