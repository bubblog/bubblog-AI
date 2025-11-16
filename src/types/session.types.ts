import { z } from 'zod';

export const sessionListQuerySchema = z.object({
  limit: z
    .preprocess((value) => (value === undefined ? undefined : Number(value)), z.number().int().min(1).max(50))
    .optional()
    .default(20),
  cursor: z.string().optional(),
  owner_user_id: z.string().min(1).optional(),
});

export const sessionMessagesQuerySchema = z.object({
  limit: z
    .preprocess((value) => (value === undefined ? undefined : Number(value)), z.number().int().min(1).max(50))
    .optional()
    .default(20),
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).optional().default('backward'),
});

export const sessionPatchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type SessionMessagesQuery = z.infer<typeof sessionMessagesQuerySchema>;
export type SessionPatchBody = z.infer<typeof sessionPatchSchema>;
