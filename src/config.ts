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
  CHAT_MODEL: z.string().default('gpt-4o'),
});

const config = configSchema.parse(process.env);

export default config;
