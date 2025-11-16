import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// 환경 변수를 스키마로 검증하여 타입 안전한 설정 객체 생성
const configSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  OPENAI_API_KEY: z.string(),
  DATABASE_URL: z.string(),
  SECRET_KEY: z.string().default('CHANGE_ME'),
  TOKEN_AUDIENCE: z.string().default('bubblog'),
  ALGORITHM: z.string().default('HS256'),
  EMBED_MODEL: z.string().default('text-embedding-3-small'),
  // 기본 LLM 모델: GPT-5 계열
  CHAT_MODEL: z.string().default('gpt-5-mini'),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_THINKING_BUDGET: z.string().optional(),
  LLM_COST_LOG: z.string().default('false'),
  LLM_COST_ROUND: z.coerce.number().default(4),
  DEBUG_ALL: z.string().default('false'),
  DEBUG_CHANNELS: z.string().default(''),
  DEBUG_EXCLUDE_TYPES: z.string().default(''),
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  EMBEDDING_QUEUE_KEY: z.string().default('embedding:queue'),
  EMBEDDING_FAILED_QUEUE_KEY: z.string().default('embedding:failed'),
  EMBEDDING_WORKER_MAX_RETRIES: z.coerce.number().default(3),
  EMBEDDING_WORKER_BACKOFF_MS: z.coerce.number().default(5000),
});

const config = configSchema.parse(process.env);

export default config;
