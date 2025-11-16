import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  deleteSessionHandler,
  getSessionHandler,
  getSessionMessagesHandler,
  listSessionsHandler,
  patchSessionHandler,
} from '../controllers/session.controller';

const sessionRouter = Router();

sessionRouter.use(authMiddleware);

sessionRouter.get('/', listSessionsHandler);
sessionRouter.get('/:id', getSessionHandler);
sessionRouter.get('/:id/messages', getSessionMessagesHandler);
sessionRouter.patch('/:id', patchSessionHandler);
sessionRouter.delete('/:id', deleteSessionHandler);

export default sessionRouter;
