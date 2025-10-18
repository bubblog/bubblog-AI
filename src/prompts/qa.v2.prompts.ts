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
    // Only time is allowed under filters. Responses JSON Schema requires closed objects
    // with explicit required fields at each level. We constrain time to label-form only.
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        time: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['label'] },
            label: { type: 'string', minLength: 1 },
          },
          required: ['type', 'label'],
        },
      },
      required: ['time'],
    },
    sort: { enum: ['created_at_desc', 'created_at_asc'] },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
  },
  required: ['mode', 'top_k', 'threshold', 'weights', 'rewrites', 'keywords', 'hybrid', 'filters', 'sort', 'limit'],
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
    '',
    'Rules:',
    '1) Output ONLY a single JSON object matching the schema. No extra text.',
    '2) Respect bounds: top_k 1..10, limit 1..20, threshold 0..1, weights in [0,1]. The server normalizes their sum.',
    '3) Do NOT output any filters other than filters.time. The server injects user_id/category_id/post_id.',
    '   - Your job: decide top_k, threshold, sort, limit; and optionally rewrites/keywords/hybrid only.',
    '4) Mode must follow constraints: if post_id exists, use mode="post"; otherwise use mode="rag".',
    '5) Time MUST be provided via a label only: filters.time = { "type": "label", "label": "..." }',
    '   - Allowed labels (examples): "all_time"(no filter), "today", "yesterday", "last_7_days", "last_14_days", "last_30_days", "this_month", "last_month",',
    '     or structured: "2006_to_now", "2019-2022", "2024-Q3", "Q3-2024", "2024-09", "2024".',
    '   - For queries like "최근 글", prefer a short window label such as "last_7_days" or "last_30_days" (choose appropriately).',
    '6) Do NOT include any temporal words or ranges inside rewrites/keywords. Temporal intent must live ONLY in filters.time.',
    '7) If the question asks for N items (e.g., “N개”), set limit=N within bounds.',
    '8) Keep weights to defaults unless a clear need implies otherwise.',
    '8) When helpful for recall, set hybrid.enabled=true and choose hybrid.retrieval_bias ∈ {lexical, balanced, semantic}. Then generate concise rewrites (<= max_rewrites) and focused keywords (<= max_keywords).',
    '   - Staged rewrites: rewrite_1 = conservative paraphrase; rewrite_2 = introduce synonyms / normalize entities; rewrite_3+ = more aggressive reformulations (higher semantic drift) that broaden phrasing while staying on-topic.',
    '   - All rewrites MUST be declarative statements (not questions). Reframe the query as neutral knowledge statements that describe the target content.',
    '   - Prefer more aggressive rewrites when the intent is conceptual/summary/why/how (often `semantic` bias). Still avoid going out-of-scope of the user corpus and do not inject temporal words.',
    '   - Interrogative → Declarative examples: “S3가 뭐야?” → “Amazon S3는 AWS의 객체 스토리지 서비스다”, “LLM 프롬프팅 가이드는?” → “LLM 프롬프팅 실전 가이드 요약”.',
    '   - Do not include “? / 뭐야 / 무엇인가 / 알려줘 / explain / what is” or any question marks in rewrites; end in a declarative tone (e.g., ~이다/입니다 or a neutral noun phrase).',
    '   - Keywords MUST be single tokens (no spaces). Prefer 1~5 short tokens in Korean/English; allow hyphen/underscore; avoid punctuation/stopwords.',
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
