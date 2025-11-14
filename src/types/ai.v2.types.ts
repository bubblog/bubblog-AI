import { z } from 'zod';

// ===== 검색 계획 JSON 스키마 (Zod) =====

// 시간 필터 스키마: LLM의 취약성을 줄이기 위해 다양한 형태 지원
export const timeFilterSchema = z.discriminatedUnion('type', [
  // 절대 ISO 범위
  z
    .object({ type: z.literal('absolute'), from: z.string(), to: z.string() })
    .strict(),
  // 상대 기간: 오늘(KST)까지 N 단위
  z
    .object({
      type: z.literal('relative'),
      unit: z.enum(['day', 'week', 'month', 'year']),
      value: z.number().int().min(1).max(365),
    })
    .strict(),
  // 특정 연도의 월 (연도는 기본적으로 현재)
  z
    .object({ type: z.literal('month'), year: z.number().int().optional(), month: z.number().int().min(1).max(12) })
    .strict(),
  // 특정 연도의 분기 (연도는 기본적으로 현재)
  z
    .object({ type: z.literal('quarter'), year: z.number().int().optional(), quarter: z.number().int().min(1).max(4) })
    .strict(),
  // 단일 연도
  z.object({ type: z.literal('year'), year: z.number().int() }).strict(),
  // 미리 정의된 기간 프리셋
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
  // 자유 형식 라벨 예시: "2006_to_now", "2024-Q3", "2019-2022", "2024-09"
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
      // LLM이 출력한 retrieval_bias 라벨을 서버에서 alpha로 매핑
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

// ===== API: /ai/v2/ask 요청 본문 스키마 =====

export const askV2Schema = z.object({
  body: z.object({
    question: z.string(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
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
