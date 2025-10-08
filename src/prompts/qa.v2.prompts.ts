// Search Plan prompt templates for v2

import { SearchPlan } from '../types/ai.v2.types';

export const getSearchPlanSchemaJson = (): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { enum: ['rag', 'post'] },
    top_k: { type: 'integer', minimum: 1, maximum: 10 },
    threshold: { type: 'number', minimum: 0, maximum: 1 },
    weights: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chunk: { type: 'number', minimum: 0, maximum: 1 },
        title: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['chunk', 'title'],
    },
    rewrites: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    hybrid: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        retrieval_bias: { enum: ['lexical', 'balanced', 'semantic'] },
        max_rewrites: { type: 'integer', minimum: 0, maximum: 4 },
        max_keywords: { type: 'integer', minimum: 0, maximum: 8 },
      },
      required: ['enabled', 'retrieval_bias', 'max_rewrites', 'max_keywords'],
    },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        user_id: { type: 'string' },
        category_ids: { type: 'array', items: { type: 'integer' } },
        post_id: { type: 'integer' },
        time: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'relative' },
                unit: { enum: ['day', 'week', 'month', 'year'] },
                value: { type: 'integer', minimum: 1 },
              },
              required: ['type', 'unit', 'value'],
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'absolute' },
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['type', 'from', 'to'],
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'month' },
                month: { type: 'integer', minimum: 1, maximum: 12 },
                year: { type: 'integer' },
              },
              required: ['type', 'month'],
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'year' },
                year: { type: 'integer' },
              },
              required: ['type', 'year'],
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                type: { const: 'quarter' },
                quarter: { type: 'integer', minimum: 1, maximum: 4 },
                year: { type: 'integer' },
              },
              required: ['type', 'quarter'],
            },
          ],
        },
      },
      required: ['user_id'],
    },
    sort: { enum: ['created_at_desc', 'created_at_asc'] },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['mode', 'top_k', 'threshold', 'weights', 'filters', 'sort', 'limit'],
});

export const buildSearchPlanPrompt = (params: {
  now_utc: string;
  now_kst: string;
  timezone: string;
  user_id: string;
  category_id?: number;
  post_id?: number;
  defaults?: Partial<SearchPlan>;
  question: string;
}): string => {
  const defaults = JSON.stringify(
    params.defaults || {
      top_k: 5,
      threshold: 0.2,
      weights: { chunk: 0.7, title: 0.3 },
      sort: 'created_at_desc',
      limit: 5,
      mode: 'rag',
      filters: { user_id: params.user_id },
    },
  );

  const schemaHint = JSON.stringify(getSearchPlanSchemaJson());

  return [
    'You are a Search Plan Generator for a Korean blogging platform.',
    'Your task is to read the user question and output ONLY a JSON object that defines a safe search plan.',
    '',
    `now_utc: ${params.now_utc}`,
    `now_kst: ${params.now_kst}`,
    `timezone: ${params.timezone}`,
    `user_id: ${params.user_id}`,
    `category_id: ${params.category_id ?? ''}`,
    `post_id: ${params.post_id ?? ''}`,
    `defaults: ${defaults}`,
    '',
    'Rules:',
    '1) Output ONLY a single JSON object matching the schema. No extra text.',
    '2) Respect bounds: top_k 1..10, limit 1..20, threshold 0..1, weights in [0,1] and sum to 1.',
    '3) Server-provided filters are FIXED constraints. Do NOT change or omit them:',
    '   - Always keep filters.user_id as provided (unchanged).',
    '   - If category_id exists, include ONLY that id in filters.category_ids (no additions/removals).',
    '   - If post_id exists, include exactly that as filters.post_id (no substitutions).',
    '   - Your job is to decide top_k, threshold, filters.time, sort, and limit only; do NOT invent other filters.',
    '4) Mode must follow constraints: if post_id exists, use mode="post"; otherwise use mode="rag".',
    '5) Interpret Korean temporal phrases into filters.time using the provided timezone. Month without year assumes current year.',
    '6) If the question asks for N items (e.g., “N개”), set limit=N within bounds.',
    '7) Keep weights to defaults unless a clear need implies otherwise.',
    '8) When helpful for recall, set hybrid.enabled=true and choose hybrid.retrieval_bias ∈ {lexical, balanced, semantic}. Then generate concise rewrites (<= max_rewrites) and focused keywords (<= max_keywords).',
    '   - lexical: keyword/정확 매칭이 중요할 때 (숫자, 버전, 고유명사 등).',
    '   - balanced: 일반 질의.',
    '   - semantic: 개념/요약/의도 중심일 때.',
    '9) Avoid stop/common words (예: "글", "포스트", "블로그", "소개", "정리"). Keep within the user context; avoid over-broad topics or time spans.',
    '10) Remove near-duplicates: if rewrites/keywords are synonymous or highly similar, include only one.',
    '',
    `Schema: ${schemaHint}`,
    '',
    `Question (Korean):\n${params.question}`,
    '',
    'Respond with ONLY the JSON object. No markdown, no explanation.',
  ].join('\n');
};
