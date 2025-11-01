import { getDb } from '../utils/db';

export type UserBlogMetadata = {
  userId: string;
  nickname?: string | null;
  profileImageUrl?: string | null;
  categoryNames: string[];
};

/**
 * Loads blog-specific metadata (nickname, profile image, category names) for a user.
 * Returns null when the user does not exist or userId is a non-real sentinel value (e.g., "global").
 */
// 사용자 블로그 메타데이터를 수집해 QA 프롬프트에 제공
export const findUserBlogMetadata = async (userId: string | null | undefined): Promise<UserBlogMetadata | null> => {
  if (!userId || userId === 'global') {
    return null;
  }

  const pool = getDb();
  const sql = `
    SELECT
      u.id,
      u.nickname,
      u.profile_image_url,
      COALESCE(
        ARRAY_AGG(c.name ORDER BY c.name) FILTER (WHERE c.id IS NOT NULL),
        '{}'::text[]
      ) AS category_names
    FROM users u
    LEFT JOIN category c ON c.user_id = u.id
    WHERE u.id = $1
    GROUP BY u.id, u.nickname, u.profile_image_url
  `;

  const { rows } = await pool.query(sql, [userId]);
  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    userId: row.id,
    nickname: row.nickname ?? null,
    profileImageUrl: row.profile_image_url ?? null,
    categoryNames: Array.isArray(row.category_names) ? row.category_names.filter((name: any) => typeof name === 'string') : [],
  };
};
