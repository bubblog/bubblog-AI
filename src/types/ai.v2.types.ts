import { z } from 'zod';

// ===== Plan JSON Schema (Zod) =====

export const timeFilterSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('relative'),
    unit: z.enum(['day', 'week', 'month', 'year']),
    value: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('absolute'),
    from: z.string(), // ISO8601
    to: z.string(),   // ISO8601
  }),
  z.object({
    type: z.literal('month'),
    month: z.number().int().min(1).max(12),
    year: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('year'),
    year: z.number().int(),
  }),
  z.object({
    type: z.literal('quarter'),
    quarter: z.number().int().min(1).max(4),
    year: z.number().int().optional(),
  }),
]);

export const planSchema = z.object({
  mode: z.enum(['rag', 'post']).default('rag'),
  top_k: z.number().int().min(1).max(10).default(5),
  threshold: z.number().min(0).max(1).default(0.2),
  weights: z
    .object({ chunk: z.number().min(0).max(1), title: z.number().min(0).max(1) })
    .default({ chunk: 0.7, title: 0.3 }),
  rewrites: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  hybrid: z
    .object({
      enabled: z.boolean().default(false),
      alpha: z.number().min(0).max(1).default(0.7),
      max_rewrites: z.number().int().min(0).max(4).default(3),
      max_keywords: z.number().int().min(0).max(8).default(6),
    })
    .default({ enabled: false, alpha: 0.7, max_rewrites: 3, max_keywords: 6 }),
  filters: z
    .object({
      user_id: z.string(),
      category_ids: z.array(z.number().int()).optional(),
      post_id: z.number().int().optional(),
      time: timeFilterSchema.optional(),
    })
    .default({ user_id: '' }),
  sort: z.enum(['created_at_desc', 'created_at_asc']).default('created_at_desc'),
  limit: z.number().int().min(1).max(20).default(5),
});

export type SearchPlan = z.infer<typeof planSchema>;

// ===== API: /ai/v2/ask =====

export const askV2Schema = z.object({
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

export type AskV2Request = z.infer<typeof askV2Schema>['body'];
