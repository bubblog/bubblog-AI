import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

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
});

const config = configSchema.parse(process.env);

export default config;
