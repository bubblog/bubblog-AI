import { getDb } from '../utils/db';

export interface Persona {
  name: string;
  description: string;
}

// 사용자별 커스텀 페르소나 정보를 조회
export const findPersonaById = async (
  personaId: number,
  userId: string
): Promise<Persona | null> => {
  const pool = getDb();
  const { rows } = await pool.query<Persona>(
    'SELECT name, description FROM persona WHERE id = $1 AND user_id = $2',
    [personaId, userId]
  );

  return rows.length > 0 ? rows[0] : null;
};
