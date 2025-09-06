import { z } from 'zod';

// POST /ai/embeddings/title
export const embedTitleSchema = z.object({
  body: z.object({
    post_id: z.number(),
    title: z.string(),
  }),
});

export type EmbedTitleRequest = z.infer<typeof embedTitleSchema>['body'];

// POST /ai/embeddings/content
export const embedContentSchema = z.object({
  body: z.object({
    post_id: z.number(),
    content: z.string(),
  }),
});

export type EmbedContentRequest = z.infer<typeof embedContentSchema>['body'];

// POST /ai/ask
export const askSchema = z.object({
  body: z.object({
    question: z.string(),
    user_id: z.string(),
    category_id: z.number().optional(),
    post_id: z.number().optional(),
    speech_tone: z.number().optional(),
  }),
});

export type AskRequest = z.infer<typeof askSchema>['body'];
