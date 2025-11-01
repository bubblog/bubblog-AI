import OpenAI from 'openai';
import config from '../config';
import { buildSearchPlanPrompt, getSearchPlanSchemaJson } from '../prompts/qa.v2.prompts';
import { planSchema, type SearchPlan } from '../types/ai.v2.types';
import { getPreset } from './retrieval-presets';
import { nowUtc, toAbsoluteRangeKst } from '../utils/time';
import { DebugLogger } from '../utils/debug-logger';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export type PlanContext = {
  user_id: string;
  category_id?: number;
  post_id?: number;
  timezone?: string; // 기본값: Asia/Seoul
};

// 질문과 컨텍스트를 기반으로 LLM에 검색 계획을 요청
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
    // 요청 전 프롬프트 내용을 디버그 출력
    DebugLogger.log('plan', {
      type: 'debug.plan.prompt',
      model: 'gpt-5-mini',
      prompt_len: prompt.length,
      head: prompt.slice(0, 600),
      tail: prompt.slice(Math.max(0, prompt.length - 600)),
    });

    const response: any = await (openai as any).responses.create({
      model: 'gpt-5-mini',
      input: prompt,
      text: { format: { type: 'json_schema', name: 'SearchPlan', schema: getSearchPlanSchemaJson()} },
      reasoning: { effort: 'minimal' },
      max_output_tokens: 1500,
    });

    // JSON 추출 전 응답 구조를 미리 로깅
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
      DebugLogger.log('plan', {
        type: 'debug.plan.response.peek',
        has_output_text: !!outputText,
        output_text_len: typeof outputText === 'string' ? outputText.length : undefined,
        output_summary: outputSummary,
      });
    } catch {}

    // 구조화된 JSON이 있으면 우선 사용하고 없으면 텍스트를 파싱
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
    // Responses API의 output_text에 JSON 문자열이 있는지도 확인
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
      // JSON 파싱 전에 원본 텍스트를 디버그 로그로 남김
      DebugLogger.log('plan', { type: 'debug.plan.raw_text', len: raw.length, head: raw.slice(0, 200) });
      if (!raw) {
        // 구조화된 출력을 파싱하지 못한 경우 우아하게 폴백
        return null;
      }

      // 균형 잡힌 첫 번째 JSON 객체를 견고하게 추출
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
          DebugLogger.warn('plan', { type: 'debug.plan.parse_fail', note: 'could not extract JSON from raw' });
        } catch {}
        return null;
      }
      parsed = candidate;
    }

    // 여전히 파싱에 실패하면 text.format 옵션 없이 폴백 호출 시도
    if (!parsed) {
      try {
        const response2: any = await (openai as any).responses.create({
          model: config.CHAT_MODEL || 'gpt-5-mini',
          input: prompt,
          max_output_tokens: 700,
        });
        // 폴백 호출 응답을 디버그로 확인
        try {
          const outputs = (response2 as any)?.output || [];
          const outputSummary = outputs.map((o: any) => ({
            role: o?.role,
            content: (o?.content || []).map((c: any) => ({
              type: c?.type,
              hasText: typeof c?.text === 'string',
              textLen: typeof c?.text === 'string' ? (c.text as string).length : undefined,
            })),
          }));
          const outputText = (response2 as any)?.output_text;
          DebugLogger.log('plan', {
            type: 'debug.plan.fallback.peek',
            has_output_text: !!outputText,
            output_text_len: typeof outputText === 'string' ? outputText.length : undefined,
            output_summary: outputSummary,
          });
        } catch {}

        // 폴백 응답을 파싱
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
          DebugLogger.warn('plan', { type: 'debug.plan.fallback.parse_fail' });
          // Chat Completions 폴백으로 진행
        }
        if (parsed2) parsed = parsed2;
      } catch {
        // Chat Completions 폴백으로 계속 진행
      }
    }

    // 최종 폴백: JSON 객체 모드의 Chat Completions 호출
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
        // 디버그 용도로 응답 개수를 기록
        DebugLogger.log('plan', { type: 'debug.plan.cc.peek', choices: (cc as any)?.choices?.length || 0 });
        const content = (cc as any)?.choices?.[0]?.message?.content || '';
        if (typeof content === 'string' && content.trim().startsWith('{')) {
          parsed = JSON.parse(content);
        }
      } catch (e) {
        DebugLogger.warn('plan', { type: 'debug.plan.cc.error', message: (e as any)?.message || 'error' });
        return null;
      }
    }
    const plan = planSchema.parse(parsed);

    // 가중치 합이 1이 되도록 정규화
    const sum = (plan.weights?.chunk ?? 0) + (plan.weights?.title ?? 0);
    const weights = sum > 0 ? { chunk: plan.weights.chunk / sum, title: plan.weights.title / sum } : { chunk: 0.7, title: 0.3 };

    // 시간 필터가 있으면 절대 범위로 정규화
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
        // 공백 없는 단일 토큰만 허용
        if (/\s/.test(raw)) continue;
        // 너무 짧은 토큰은 제외
        if (raw.length < 2) continue;
        // 한글·영문·숫자와 하이픈/언더스코어만 허용하여 단어 형태 유지
        const token = raw.replace(/[\u200B-\u200D\uFEFF]/g, '');
        if (!/^[\p{L}\p{N}_-]+$/u.test(token)) continue;
        const key = token.toLowerCase();
        if (stopwords.has(key)) continue;
        if (uniq.has(key)) continue;
        uniq.add(key);
      }
      // 최종 개수를 1~5 범위로 제한
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
        // 유효하지 않은 시간 필터는 제거
        const { time, ...rest } = normPlan.filters || ({} as any);
        normPlan = { ...normPlan, filters: rest as any };
      }
    }

    // 혹시 모를 값에 대비해 범위를 강제
    normPlan.top_k = Math.min(10, Math.max(1, normPlan.top_k || 5));
    normPlan.limit = Math.min(20, Math.max(1, normPlan.limit || 5));
    normPlan.threshold = Math.min(1, Math.max(0, normPlan.threshold ?? 0.2));
    const maxRewrites = clamp(plan.hybrid?.max_rewrites ?? 3, 0, 4);
    // 계획에서 최대 8개를 제안해도 품질을 위해 1~5개로 정규화
    const maxKeywords = Math.min(5, clamp(plan.hybrid?.max_keywords ?? 6, 0, 8));

    // retrieval_bias에 따라 alpha 값을 재계산 (명시 값이 있으면 우선)
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

    // 참고: SearchPlan 스키마 요구사항상 filters.time만 유지한다.
    //       user_id/category_ids/post_id는 쿼리 단계에서 주입된다.

    // 최종 파싱·정규화된 계획을 로그로 남김
    const timeInfo = (normPlan as any)?.filters?.time;
    DebugLogger.log('plan', {
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
    });

    return { plan, normalized: normPlan };
  } catch (e) {
    DebugLogger.error('plan', { type: 'debug.plan.error', message: (e as any)?.message || 'error' });
    return null;
  }
};
