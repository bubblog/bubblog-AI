import OpenAI from 'openai';
import config from '../config';
import { buildSearchPlanPrompt, getSearchPlanSchemaJson } from '../prompts/qa.v2.prompts';
import { planSchema, type SearchPlan } from '../types/ai.v2.types';
import { nowUtc, toAbsoluteRangeKst } from '../utils/time';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export type PlanContext = {
  user_id: string;
  category_id?: number;
  post_id?: number;
  timezone?: string; // default Asia/Seoul
};

export const generateSearchPlan = async (
  question: string,
  ctx: PlanContext
): Promise<{ plan: SearchPlan; normalized: SearchPlan } | null> => {
  const timezone = ctx.timezone || 'Asia/Seoul';
  const now = nowUtc();
  const nowUtcIso = now.toISOString();
  const nowKstIso = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();

  const prompt = buildSearchPlanPrompt({
    now_utc: nowUtcIso,
    now_kst: nowKstIso,
    timezone,
    user_id: ctx.user_id,
    category_id: ctx.category_id,
    post_id: ctx.post_id,
    question,
  });

  const schema = getSearchPlanSchemaJson();

  try {
    const response: any = await (openai as any).responses.create({
      model: config.CHAT_MODEL || 'gpt-5-mini',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      response_format: { type: 'json_schema', json_schema: { name: 'SearchPlan', schema, strict: true } },
      max_output_tokens: 600,
    });

    const text = (response as any)?.output_text || '';
    const raw = text && text.trim().startsWith('{') ? text : (() => {
      // Fallback: try to extract JSON from response.output
      try {
        const outputs = (response as any).output || [];
        const parts = outputs
          .flatMap((o: any) => o.content || [])
          .filter((c: any) => typeof c?.text === 'string')
          .map((c: any) => c.text)
          .join('');
        return parts;
      } catch {
        return '';
      }
    })();
    const parsed = JSON.parse(raw);
    const plan = planSchema.parse(parsed);

    // Normalize weights sum to 1
    const sum = (plan.weights?.chunk ?? 0) + (plan.weights?.title ?? 0);
    const weights = sum > 0 ? { chunk: plan.weights.chunk / sum, title: plan.weights.title / sum } : { chunk: 0.7, title: 0.3 };

    // Normalize time range to absolute if provided
    let normPlan: SearchPlan = { ...plan, weights };

    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

    const stopwords = new Set([
      '글',
      '포스트',
      '블로그',
      '소개',
      '정리',
      '내용',
      '최신',
      '최근',
      '정보',
    ]);

    const cleanList = (arr: string[] | undefined, max: number) => {
      const uniq = new Set<string>();
      for (const s of arr || []) {
        const t = String(s || '').trim();
        if (!t) continue;
        if (t.length < 2) continue;
        if (stopwords.has(t)) continue;
        const key = t.toLowerCase();
        if (uniq.has(key)) continue;
        uniq.add(key);
      }
      return Array.from(uniq).slice(0, max);
    };
    if (plan.filters?.time) {
      const abs = toAbsoluteRangeKst(plan.filters.time as any, now);
      if (abs) {
        normPlan = {
          ...normPlan,
          filters: { ...normPlan.filters, time: { type: 'absolute', from: abs.from, to: abs.to } as any },
        };
      } else {
        // drop invalid time
        const { time, ...rest } = normPlan.filters || ({} as any);
        normPlan = { ...normPlan, filters: rest as any };
      }
    }

    // Enforce bounds just in case
    normPlan.top_k = Math.min(10, Math.max(1, normPlan.top_k || 5));
    normPlan.limit = Math.min(20, Math.max(1, normPlan.limit || 5));
    normPlan.threshold = Math.min(1, Math.max(0, normPlan.threshold ?? 0.2));
    const maxRewrites = clamp(plan.hybrid?.max_rewrites ?? 3, 0, 4);
    const maxKeywords = clamp(plan.hybrid?.max_keywords ?? 6, 0, 8);

    // Map retrieval_bias -> alpha (fallback to provided alpha or default)
    const bias = (plan.hybrid as any)?.retrieval_bias || 'balanced';
    const biasAlpha = bias === 'lexical' ? 0.3 : bias === 'semantic' ? 0.75 : 0.5;
    const alpha = clamp(((plan.hybrid as any)?.alpha ?? biasAlpha) as number, 0, 1);

    normPlan.hybrid = {
      enabled: !!plan.hybrid?.enabled,
      retrieval_bias: bias,
      alpha,
      max_rewrites: maxRewrites,
      max_keywords: maxKeywords,
    } as any;
    normPlan.rewrites = cleanList(plan.rewrites, maxRewrites) as any;
    normPlan.keywords = cleanList(plan.keywords, maxKeywords) as any;
    if (!normPlan.mode) normPlan.mode = (ctx.post_id ? 'post' : 'rag') as any;
    if (ctx.category_id && !normPlan.filters.category_ids) normPlan.filters.category_ids = [ctx.category_id];
    if (ctx.post_id) {
      normPlan.mode = 'post';
      normPlan.filters.post_id = ctx.post_id;
    }

    return { plan, normalized: normPlan };
  } catch (e) {
    try {
      console.error(JSON.stringify({ type: 'debug.plan.error', message: (e as any)?.message || 'error' }));
    } catch {}
    return null;
  }
};
