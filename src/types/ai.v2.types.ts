import { z } from 'zod';

// ===== Plan JSON Schema (Zod) =====

// Time filter schema: support multiple shapes to reduce LLM fragility
export const timeFilterSchema = z.discriminatedUnion('type', [
  // Absolute ISO range
  z
    .object({ type: z.literal('absolute'), from: z.string(), to: z.string() })
    .strict(),
  // Relative window: N units up to today (KST)
  z
    .object({
      type: z.literal('relative'),
      unit: z.enum(['day', 'week', 'month', 'year']),
      value: z.number().int().min(1).max(365),
    })
    .strict(),
  // Month of a year (default year=now)
  z
    .object({ type: z.literal('month'), year: z.number().int().optional(), month: z.number().int().min(1).max(12) })
    .strict(),
  // Quarter of a year (default year=now)
  z
    .object({ type: z.literal('quarter'), year: z.number().int().optional(), quarter: z.number().int().min(1).max(4) })
    .strict(),
  // Single year
  z.object({ type: z.literal('year'), year: z.number().int() }).strict(),
  // Named presets (limited set)
  z
    .object({
      type: z.literal('named'),
      preset: z.enum([
        'all_time',
        'all',
        'today',
        'yesterday',
        'last_7_days',
        'last_14_days',
        'last_30_days',
        'this_month',
        'last_month',
      ]),
    })
    .strict(),
  // Free-form label, e.g., "2006_to_now", "2024-Q3", "2019-2022", "2024-09"
  z.object({ type: z.literal('label'), label: z.string().min(1) }).strict(),
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
      // LLM outputs retrieval_bias label; server maps to alpha
      retrieval_bias: z.enum(['lexical', 'balanced', 'semantic']).default('balanced'),
      alpha: z.number().min(0).max(1).optional(),
      max_rewrites: z.number().int().min(0).max(4).default(3),
      max_keywords: z.number().int().min(0).max(8).default(6),
    })
    .default({ enabled: false, retrieval_bias: 'balanced', max_rewrites: 3, max_keywords: 6 }),
  filters: z
    .object({
      time: timeFilterSchema.optional(),
    })
    .strict()
    .optional(),
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
