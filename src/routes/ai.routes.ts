import { Router } from 'express';
import {
  embedTitleHandler,
  embedContentHandler,
  askHandler,
} from '../controllers/ai.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const aiRouter = Router();

aiRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

aiRouter.post('/embeddings/title', embedTitleHandler);
aiRouter.post('/embeddings/content', embedContentHandler);
aiRouter.post('/ask', authMiddleware, askHandler);

export default aiRouter;
