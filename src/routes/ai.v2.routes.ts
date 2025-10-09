import { Router } from 'express';
import { askV2Handler } from '../controllers/ai.v2.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const aiV2Router = Router();

aiV2Router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', v: 'v2' });
});

aiV2Router.post('/ask', authMiddleware, askV2Handler);

export default aiV2Router;

