import { z } from 'zod';

// POST /ai/embeddings/title 요청 본문 스키마
export const embedTitleSchema = z.object({
  body: z.object({
    post_id: z.number(),
    title: z.string(),
  }),
});

export type EmbedTitleRequest = z.infer<typeof embedTitleSchema>['body'];

// POST /ai/embeddings/content 요청 본문 스키마
export const embedContentSchema = z.object({
  body: z.object({
    post_id: z.number(),
    content: z.string(),
  }),
});

export type EmbedContentRequest = z.infer<typeof embedContentSchema>['body'];

// POST /ai/ask 요청 본문 스키마
export const askSchema = z.object({
  body: z.object({
    question: z.string(),
    user_id: z.string(),
    category_id: z.number().optional(),
    post_id: z.number().optional(),
    speech_tone: z.number().optional(),
    llm: z
      .object({
        provider: z.enum(['openai', 'gemini']).optional(),
        model: z.string().optional(),
        options: z
          .object({
            temperature: z.number().optional(),
            top_p: z.number().optional(),
            max_output_tokens: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

export type AskRequest = z.infer<typeof askSchema>['body'];
