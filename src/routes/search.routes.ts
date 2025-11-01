import { Router } from 'express';
import { hybridSearchHandler } from '../controllers/search.controller';

// 공개 검색용 하이브리드 엔드포인트 라우터
const searchRouter = Router();

// SSE 없이 JSON으로 응답하는 공개 엔드포인트
searchRouter.get('/hybrid', hybridSearchHandler);

export default searchRouter;
