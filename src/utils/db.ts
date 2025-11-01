import { Pool } from 'pg';
import config from '../config';

const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

// 재사용 가능한 PG 풀 인스턴스를 반환
export const getDb = () => {
  return pool;
};
