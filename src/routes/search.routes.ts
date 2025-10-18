import { Router } from 'express';
import { hybridSearchHandler } from '../controllers/search.controller';

const searchRouter = Router();

// Public JSON endpoint (no SSE)
searchRouter.get('/hybrid', hybridSearchHandler);

export default searchRouter;

