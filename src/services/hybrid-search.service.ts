import { createEmbeddings } from './embedding.service';
import { getPreset } from './retrieval-presets';
import * as postRepository from '../repositories/post.repository';
import { SearchPlan } from '../types/ai.v2.types';

export type HybridSearchResult = {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
  chunkIndex?: number;
  postCreatedAt?: string;
}[];

type Candidate = {
  postId: string;
  postTitle: string;
  postChunk: string;
  chunkIndex?: number;
  vecScore?: number;
  textScore?: number;
  postCreatedAt?: string;
};

export const runHybridSearch = async (
  question: string,
  userId: string,
  plan: SearchPlan,
  opts?: { categoryId?: number; limit?: number; global?: boolean }
): Promise<HybridSearchResult> => {
  const rewrites = ((plan.rewrites as string[]) || []);
  const queries = [question, ...rewrites];
  const bias = ((plan.hybrid as any)?.retrieval_bias || 'balanced') as any;
  const preset = getPreset(bias);
  const alpha = Math.max(0, Math.min(1, (plan.hybrid as any)?.alpha ?? preset.alpha));

  const from = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.from : undefined;
  const to = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.to : undefined;
  const categoryId = opts?.categoryId;

  const embeddings = await createEmbeddings(queries);

  // Compute per-rewrite similarity weights (index 0 = original question)
  const dot = (a: number[], b: number[]) => {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += (a[i] || 0) * (b[i] || 0);
    return s;
  };
  const l2 = (a: number[]) => Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
  const cos = (a: number[], b: number[]) => {
    const na = l2(a);
    const nb = l2(b);
    if (na === 0 || nb === 0) return 0;
    return dot(a, b) / (na * nb);
  };

  const qEmb = embeddings[0];
  const weightsByIndex: number[] = new Array(embeddings.length).fill(1);
  const keepIndex: boolean[] = new Array(embeddings.length).fill(true);
  const floor = 0.35; // similarity floor in [0,1]
  const isDeclarative = (s: string): boolean => {
    const str = (s || '').trim();
    if (!str) return false;
    if (/[?？]$/.test(str) || str.includes('?')) return false;
    const lower = str.toLowerCase();
    if (/입니다[.!]?$/.test(str) || /이다[.!]?$/.test(str) || /다[.!]?$/.test(str)) return true;
    if (/( is | are | was | were )/.test(` ${lower} `)) return true;
    if (/[.!]$/.test(str)) return true;
    return false;
  };

  for (let i = 1; i < embeddings.length; i++) {
    const sim = cos(qEmb, embeddings[i]); // [-1,1]
    const sim01 = Math.max(0, Math.min(1, (sim + 1) / 2));
    let weight = 0.6 + 0.6 * sim01; // map to [0.6, 1.2]
    const rw = rewrites[i - 1] || '';
    if (isDeclarative(rw)) {
      const floorBase = bias === 'semantic' ? 1.0 : 0.95;
      if (weight < floorBase) weight = floorBase;
    }
    weightsByIndex[i] = weight;
    if (sim01 < floor) keepIndex[i] = false; // drop low-quality rewrites for vector path
  }

  // Telemetry: rewrite weights
  try {
    console.log(
      JSON.stringify(
        {
          type: 'debug.hybrid.rewrite_weights',
          rewrites,
          weights: weightsByIndex.slice(1),
          kept: keepIndex.slice(1),
          decl_flags: rewrites.map((r) => isDeclarative(r)),
          alpha,
        },
        null,
        0,
      ),
    );
  } catch {}

  const byKey = new Map<string, Candidate>();

  for (let i = 0; i < embeddings.length; i++) {
    if (!keepIndex[i]) continue;
    const emb = embeddings[i];
    const rows = opts?.global
      ? await postRepository.findSimilarChunksGlobalANN({
          embedding: emb,
          threshold: plan.threshold,
          topK: plan.top_k * 5,
          weights: plan.weights,
          sort: plan.sort,
          annFactor: 5,
        })
      : await postRepository.findSimilarChunksV2({
          userId,
          embedding: emb,
          categoryId,
          from,
          to,
          threshold: plan.threshold,
          topK: plan.top_k,
          weights: plan.weights,
          sort: plan.sort,
        });
    for (const r of rows) {
      const key = `${r.postId}:${(r as any).chunkIndex ?? r.postChunk}`;
      const prev = byKey.get(key);
      const curVec = (Number(r.similarityScore) || 0) * (weightsByIndex[i] || 1);
      if (!prev) {
        byKey.set(key, { postId: r.postId, postTitle: r.postTitle, postChunk: r.postChunk, chunkIndex: (r as any).chunkIndex, vecScore: curVec, postCreatedAt: (r as any).postCreatedAt });
      } else {
        prev.vecScore = Math.max(prev.vecScore || 0, curVec);
      }
    }
  }

  const textRows = opts?.global
    ? await postRepository.textSearchChunksGlobal({
        query: question,
        keywords: (plan.keywords as string[]) || [],
        topK: plan.top_k * 3,
        sort: plan.sort,
      })
    : await postRepository.textSearchChunksV2({
        userId,
        query: question,
        keywords: (plan.keywords as string[]) || [],
        categoryId,
        from,
        to,
        topK: plan.top_k,
        sort: plan.sort,
      });
  for (const r of textRows) {
    const key = `${r.postId}:${(r as any).chunkIndex ?? r.postChunk}`;
    const prev = byKey.get(key);
    const curText = Number(r.textScore) || 0;
    if (!prev) {
      byKey.set(key, { postId: r.postId, postTitle: r.postTitle, postChunk: r.postChunk, chunkIndex: (r as any).chunkIndex, textScore: curText, postCreatedAt: (r as any).postCreatedAt });
    } else {
      prev.textScore = Math.max(prev.textScore || 0, curText);
    }
  }

  let semBoostCount = 0;
  let lexBoostCount = 0;

  // Extend lexical search to rewrites as queries for recall
  for (let i = 1; i < embeddings.length; i++) {
    if (!keepIndex[i]) continue;
    const q = rewrites[i - 1];
    if (!q || typeof q !== 'string' || !q.trim()) continue;
    try {
      const rows = opts?.global
        ? await postRepository.textSearchChunksGlobal({
            query: q,
            keywords: (plan.keywords as string[]) || [],
            topK: plan.top_k * 3,
            sort: plan.sort,
          })
        : await postRepository.textSearchChunksV2({
            userId,
            query: q,
            keywords: (plan.keywords as string[]) || [],
            categoryId,
            from,
            to,
            topK: plan.top_k,
            sort: plan.sort,
          });
      for (const r of rows) {
        const key = `${r.postId}:${(r as any).chunkIndex ?? r.postChunk}`;
        const prev = byKey.get(key);
        const curText = Number(r.textScore) || 0;
        if (!prev) {
          byKey.set(key, { postId: r.postId, postTitle: r.postTitle, postChunk: r.postChunk, chunkIndex: (r as any).chunkIndex, textScore: curText, postCreatedAt: (r as any).postCreatedAt });
        } else {
          prev.textScore = Math.max(prev.textScore || 0, curText);
        }
      }
    } catch {}
  }

  const list = Array.from(byKey.values());
  const vecVals = list.map((c) => c.vecScore || 0);
  const textVals = list.map((c) => c.textScore || 0);
  const vMin = Math.min(...vecVals, 0);
  const vMax = Math.max(...vecVals, 0);
  const tMin = Math.min(...textVals, 0);
  const tMax = Math.max(...textVals, 0);

  const normalize01 = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);

  const boosted = list.map((c) => {
    let v = normalize01(c.vecScore || 0, vMin, vMax);
    let t = normalize01(c.textScore || 0, tMin, tMax);
    // Threshold-based boosts
    if (v >= preset.sem_boost_threshold) {
      v = Math.min(1, v + 0.1);
      semBoostCount++;
    }
    if (t >= preset.lex_boost_threshold) {
      t = Math.min(1, t + 0.1);
      lexBoostCount++;
    }
    const score = alpha * v + (1 - alpha) * t;
    return { postId: c.postId, postTitle: c.postTitle, postChunk: c.postChunk, similarityScore: score, chunkIndex: c.chunkIndex, postCreatedAt: c.postCreatedAt };
  });

  // Telemetry for boosts
  try {
    console.log(
      JSON.stringify(
        {
          type: 'debug.hybrid.boosts',
          bias,
          alpha,
          sem_thr: preset.sem_boost_threshold,
          lex_thr: preset.lex_boost_threshold,
          counts: { sem: semBoostCount, lex: lexBoostCount },
        },
        null,
        0,
      ),
    );
  } catch {}

  // Post-level diversity: max N chunks per post before final limit
  const MAX_CHUNKS_PER_POST = 2;
  const sorted = boosted.sort((a, b) => b.similarityScore - a.similarityScore);
  const byPostCount = new Map<string, number>();
  const diversified: typeof sorted = [];
  for (const r of sorted) {
    const c = byPostCount.get(r.postId) || 0;
    if (c >= MAX_CHUNKS_PER_POST) continue;
    byPostCount.set(r.postId, c + 1);
    diversified.push(r);
  }

  const fused = diversified.slice(0, Math.min(20, Math.max(1, (opts?.limit ?? plan.limit ?? 5))));

  return fused;
};
