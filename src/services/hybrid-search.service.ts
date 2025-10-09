import { createEmbeddings } from './embedding.service';
import * as postRepository from '../repositories/post.repository';
import { SearchPlan } from '../types/ai.v2.types';

export type HybridSearchResult = {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
}[];

type Candidate = {
  postId: string;
  postTitle: string;
  postChunk: string;
  vecScore?: number;
  textScore?: number;
};

export const runHybridSearch = async (
  question: string,
  userId: string,
  plan: SearchPlan
): Promise<HybridSearchResult> => {
  const queries = [question, ...((plan.rewrites as string[]) || [])];
  const alpha = Math.max(0, Math.min(1, (plan.hybrid as any)?.alpha ?? 0.7));

  const from = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.from : undefined;
  const to = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.to : undefined;
  const categoryId = (plan.filters as any)?.category_ids?.[0];

  const embeddings = await createEmbeddings(queries);

  const byKey = new Map<string, Candidate>();

  for (let i = 0; i < embeddings.length; i++) {
    const emb = embeddings[i];
    const rows = await postRepository.findSimilarChunksV2({
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
      const key = `${r.postId}:${r.postChunk}`;
      const prev = byKey.get(key);
      const curVec = Number(r.similarityScore) || 0;
      if (!prev) {
        byKey.set(key, { postId: r.postId, postTitle: r.postTitle, postChunk: r.postChunk, vecScore: curVec });
      } else {
        prev.vecScore = Math.max(prev.vecScore || 0, curVec);
      }
    }
  }

  const textRows = await postRepository.textSearchChunksV2({
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
    const key = `${r.postId}:${r.postChunk}`;
    const prev = byKey.get(key);
    const curText = Number(r.textScore) || 0;
    if (!prev) {
      byKey.set(key, { postId: r.postId, postTitle: r.postTitle, postChunk: r.postChunk, textScore: curText });
    } else {
      prev.textScore = Math.max(prev.textScore || 0, curText);
    }
  }

  const list = Array.from(byKey.values());
  const vecVals = list.map((c) => c.vecScore || 0);
  const textVals = list.map((c) => c.textScore || 0);
  const vMin = Math.min(...vecVals, 0);
  const vMax = Math.max(...vecVals, 0);
  const tMin = Math.min(...textVals, 0);
  const tMax = Math.max(...textVals, 0);

  const norm = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0);

  const fused = list
    .map((c) => {
      const v = norm(c.vecScore || 0, vMin, vMax);
      const t = norm(c.textScore || 0, tMin, tMax);
      const score = alpha * v + (1 - alpha) * t;
      return { postId: c.postId, postTitle: c.postTitle, postChunk: c.postChunk, similarityScore: score };
    })
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, Math.min(10, Math.max(1, plan.top_k || 5)));

  return fused;
};

