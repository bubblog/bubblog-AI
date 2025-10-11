import OpenAI from 'openai';
import config from '../config';
import { buildSearchPlanPrompt, getSearchPlanSchemaJson } from '../prompts/qa.v2.prompts';
import { planSchema, type SearchPlan } from '../types/ai.v2.types';
import { getPreset } from './retrieval-presets';
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


  try {
    // Debug prompt before request
    try {
      console.log(
        JSON.stringify(
          {
            type: 'debug.plan.prompt',
            model: 'gpt-5-mini',
            prompt_len: prompt.length,
            head: prompt.slice(0, 600),
            tail: prompt.slice(Math.max(0, prompt.length - 600)),
          },
          null,
          0,
        ),
      );
    } catch {}

    const response: any = await (openai as any).responses.create({
      model: 'gpt-5-mini',
      input: prompt,
      text: { format: { type: 'json_schema', name: 'SearchPlan', schema: getSearchPlanSchemaJson()} },
      reasoning: { effort: 'minimal' },
      max_output_tokens: 1500,
    });

    // Debug peek: log response shapes before JSON extraction
    try {
      const outputs = (response as any)?.output || [];
      const outputSummary = outputs.map((o: any) => ({
        role: o?.role,
        content: (o?.content || []).map((c: any) => ({
          type: c?.type,
          hasText: typeof c?.text === 'string',
          textLen: typeof c?.text === 'string' ? (c.text as string).length : undefined,
          hasJson: !!c?.json,
        })),
      }));
      const outputText = (response as any)?.output_text;
      console.log(
        JSON.stringify(
          { type: 'debug.plan.response.peek', has_output_text: !!outputText, output_text_len: typeof outputText === 'string' ? outputText.length : undefined, output_summary: outputSummary },
          null,
          0,
        ),
      );
    } catch {}

    // Extract structured JSON if available, otherwise parse text
    let parsed: any = null;
    try {
      const outputs = (response as any)?.output || [];
      for (const o of outputs) {
        for (const c of (o?.content || [])) {
          if (c && (c.type === 'json' || c.type === 'output_json') && c.json) {
            parsed = c.json;
            break;
          }
        }
        if (parsed) break;
      }
    } catch {}
    // Also check output_text for JSON string if using Responses API response_format
    if (!parsed && typeof (response as any)?.output_text === 'string') {
      const s = ((response as any).output_text as string).trim();
      if (s.startsWith('{')) {
        try { parsed = JSON.parse(s); } catch {}
      }
    }
    if (!parsed) {
      const texts: string[] = [];
      const ot = (response as any)?.output_text;
      if (typeof ot === 'string') texts.push(ot);
      try {
        const outputs = (response as any)?.output || [];
        for (const o of outputs) {
          for (const c of (o?.content || [])) {
            const t = typeof c?.text === 'string' ? c.text : undefined;
            if (t) texts.push(t);
          }
        }
      } catch {}
      const raw = texts.join('').trim();
      // Debug: log raw text before JSON.parse
      try {
        console.log(
          JSON.stringify(
            { type: 'debug.plan.raw_text', len: raw.length, head: raw.slice(0, 200) },
            null,
            0,
          ),
        );
      } catch {}
      if (!raw) {
        // Graceful fallback: unable to parse structured output
        return null;
      }

      // Robust extraction of first balanced JSON object
      const tryParse = (s: string): any | null => {
        try { return JSON.parse(s); } catch { return null; }
      };
      let candidate = tryParse(raw);
      if (!candidate) {
        const start = raw.indexOf('{');
        if (start >= 0) {
          let depth = 0;
          let inStr = false;
          let esc = false;
          for (let i = start; i < raw.length; i++) {
            const ch = raw[i];
            if (inStr) {
              if (esc) esc = false;
              else if (ch === '\\') esc = true;
              else if (ch === '"') inStr = false;
            } else {
              if (ch === '"') inStr = true;
              else if (ch === '{') depth++;
              else if (ch === '}') {
                depth--;
                if (depth === 0) {
                  const sub = raw.slice(start, i + 1);
                  candidate = tryParse(sub);
                  if (candidate) break;
                }
              }
            }
          }
          if (!candidate) {
            const last = raw.lastIndexOf('}');
            if (last > start) candidate = tryParse(raw.slice(start, last + 1));
          }
        }
      }
      if (!candidate) {
        try {
          console.warn(JSON.stringify({ type: 'debug.plan.parse_fail', note: 'could not extract JSON from raw' }));
        } catch {}
        return null;
      }
      parsed = candidate;
    }

    // If still no parsed plan at this point, try a fallback call without text.format
    if (!parsed) {
      try {
        const response2: any = await (openai as any).responses.create({
          model: config.CHAT_MODEL || 'gpt-5-mini',
          input: prompt,
          max_output_tokens: 700,
        });
        // Debug peek for fallback
        try {
          const outputs = (response2 as any)?.output || [];
          const outputSummary = outputs.map((o: any) => ({
            role: o?.role,
            content: (o?.content || []).map((c: any) => ({ type: c?.type, hasText: typeof c?.text === 'string', textLen: typeof c?.text === 'string' ? (c.text as string).length : undefined }))
          }));
          const outputText = (response2 as any)?.output_text;
          console.log(JSON.stringify({ type: 'debug.plan.fallback.peek', has_output_text: !!outputText, output_text_len: typeof outputText === 'string' ? outputText.length : undefined, output_summary: outputSummary }));
        } catch {}

        // Parse fallback response
        let parsed2: any = null;
        try {
          const outputs = (response2 as any)?.output || [];
          for (const o of outputs) {
            for (const c of (o?.content || [])) {
              const t = typeof c?.text === 'string' ? c.text : undefined;
              if (t) {
                const s = t.trim();
                if (s.startsWith('{')) { try { parsed2 = JSON.parse(s); } catch {} }
                if (parsed2) break;
              }
            }
            if (parsed2) break;
          }
        } catch {}
        if (!parsed2) {
          const ot = (response2 as any)?.output_text;
          if (typeof ot === 'string') {
            const s = ot.trim();
            try { parsed2 = JSON.parse(s); } catch {}
          }
        }
        if (!parsed2) {
          console.warn(JSON.stringify({ type: 'debug.plan.fallback.parse_fail' }));
          // proceed to chat completions fallback
        }
        if (parsed2) parsed = parsed2;
      } catch {
        // continue to chat completions fallback
      }
    }

    // Final fallback: Chat Completions with JSON object mode
    if (!parsed) {
      try {
        const sys = 'You output ONLY a single JSON object matching the SearchPlan shape. No extra text.';
        const userMsg = prompt;
        const cc: any = await (openai as any).chat.completions.create({
          model: config.CHAT_MODEL || 'gpt-5-mini',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 700,
        });
        // Debug
        try {
          console.log(JSON.stringify({ type: 'debug.plan.cc.peek', choices: (cc as any)?.choices?.length || 0 }));
        } catch {}
        const content = (cc as any)?.choices?.[0]?.message?.content || '';
        if (typeof content === 'string' && content.trim().startsWith('{')) {
          parsed = JSON.parse(content);
        }
      } catch (e) {
        try { console.warn(JSON.stringify({ type: 'debug.plan.cc.error', message: (e as any)?.message || 'error' })); } catch {}
        return null;
      }
    }
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

    const cleanKeywords = (arr: string[] | undefined, max: number) => {
      const uniq = new Set<string>();
      for (const s of arr || []) {
        const raw = String(s || '').trim();
        if (!raw) continue;
        // Single-token only (no whitespace)
        if (/\s/.test(raw)) continue;
        // Drop too short tokens
        if (raw.length < 2) continue;
        // Allow only word-ish tokens with optional hyphen/underscore (Korean/English/numbers)
        const token = raw.replace(/[\u200B-\u200D\uFEFF]/g, '');
        if (!/^[\p{L}\p{N}_-]+$/u.test(token)) continue;
        const key = token.toLowerCase();
        if (stopwords.has(key)) continue;
        if (uniq.has(key)) continue;
        uniq.add(key);
      }
      // cap to 1..5
      const list = Array.from(uniq);
      return list.slice(0, Math.min(5, Math.max(0, max)));
    };
    if ((plan as any)?.filters?.time) {
      const abs = toAbsoluteRangeKst(plan.filters?.time as any, now);
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
    // Even if plan suggests up to 8, we normalize to 1..5 for quality
    const maxKeywords = Math.min(5, clamp(plan.hybrid?.max_keywords ?? 6, 0, 8));

    // Map retrieval_bias -> alpha (fallback to provided alpha or default)
    const bias = (plan.hybrid as any)?.retrieval_bias || 'balanced';
    const preset = getPreset(bias as any);
    const alpha = clamp(((plan.hybrid as any)?.alpha ?? preset.alpha) as number, 0, 1);

    normPlan.hybrid = {
      enabled: !!plan.hybrid?.enabled,
      retrieval_bias: bias,
      alpha,
      max_rewrites: maxRewrites,
      max_keywords: maxKeywords,
    } as any;
    normPlan.rewrites = cleanList(plan.rewrites, maxRewrites) as any;
    normPlan.keywords = cleanKeywords(plan.keywords, maxKeywords) as any;
    if (!normPlan.mode) normPlan.mode = (ctx.post_id ? 'post' : 'rag') as any;

    // Note: Only filters.time is kept here to satisfy the SearchPlan schema.
    //       user_id/category_ids/post_id will be injected later by the query layer.

    // Console debug: final parsed + normalized plan
    try {
      const timeInfo = (normPlan as any)?.filters?.time;
      console.log(
        JSON.stringify(
          {
            type: 'debug.plan.final',
            ctx: { user_id: ctx.user_id, category_id: ctx.category_id, post_id: ctx.post_id },
            summary: {
              mode: normPlan.mode,
              top_k: normPlan.top_k,
              threshold: normPlan.threshold,
              weights: normPlan.weights,
              sort: normPlan.sort,
              limit: normPlan.limit,
              hybrid: {
                enabled: !!normPlan.hybrid?.enabled,
                retrieval_bias: normPlan.hybrid?.retrieval_bias,
                alpha: normPlan.hybrid?.alpha,
                max_rewrites: normPlan.hybrid?.max_rewrites,
                max_keywords: normPlan.hybrid?.max_keywords,
              },
              time: timeInfo ? { type: timeInfo.type, from: timeInfo.from, to: timeInfo.to } : null,
              rewrites_len: (normPlan.rewrites || []).length,
              keywords_len: (normPlan.keywords || []).length,
              keywords_preview: (normPlan.keywords || []).slice(0, 5),
            },
            plan,
            normalized: normPlan,
          },
          null,
          0,
        ),
      );
    } catch {}

    return { plan, normalized: normPlan };
  } catch (e) {
    try {
      console.error(JSON.stringify({ type: 'debug.plan.error', message: (e as any)?.message || 'error' }));
    } catch {}
    return null;
  }
};
