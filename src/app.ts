import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import aiRouter from './routes/ai.routes';
import aiV2Router from './routes/ai.v2.routes';
import searchRouter from './routes/search.routes';

// Express 애플리케이션과 공용 미들웨어를 초기화
const app: Express = express();

// CORS 설정
const allowedOrigins = ['http://localhost:3001', 'https://bubblog-fe.vercel.app', 'https://bubblog.kro.kr'];

const corsOptions: cors.CorsOptions = {
  origin: allowedOrigins,
  credentials: true, // 인증 정보 포함 허용
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (request: Request, response: Response) => {
  response.send('Welcome to bubblog-ai API');
});

app.use('/ai', aiRouter);
app.use('/ai/v2', aiV2Router);
app.use('/search', searchRouter);

// 중앙 에러 처리기
// 전역 에러 처리기로 예기치 못한 서버 오류를 JSON으로 반환
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: {
      message: err.message || 'An unexpected error occurred',
      // stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    }
  });
});

export default app;
