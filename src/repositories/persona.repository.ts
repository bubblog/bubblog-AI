import { getDb } from '../utils/db';

export interface Persona {
  name: string;
  description: string;
}

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
