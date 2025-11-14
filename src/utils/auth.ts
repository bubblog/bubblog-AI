import { AuthRequest } from '../middlewares/auth.middleware';

export const extractRequesterId = (req: AuthRequest): string | null => {
  const user = req.user;
  if (!user || typeof user !== 'object') return null;

  const candidate = (user as Record<string, unknown>).user_id ?? (user as Record<string, unknown>).sub;
  return typeof candidate === 'string' ? candidate : null;
};
