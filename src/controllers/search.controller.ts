import { Request, Response } from 'express';
import { generateSearchPlan } from '../services/search-plan.service';
import { runHybridSearch } from '../services/hybrid-search.service';
import { runSemanticSearch } from '../services/semantic-search.service';
import { aggregatePosts } from '../services/search-aggregate.service';

// 하이브리드 검색 API로 질문을 받아 검색 계획과 결과를 반환
export const hybridSearchHandler = async (req: Request, res: Response) => {
  try {
    const question = String(req.query.question || '').trim();
    const categoryId = req.query.category_id != null ? Number(req.query.category_id) : undefined;
    const limit = req.query.limit != null ? Math.max(1, Math.min(10, Number(req.query.limit))) : 10;
    const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset)) : 0;

    if (!question) {
      res.status(400).json({ error: { message: 'Missing required param: question' } });
      return;
    }

    const planPair = await generateSearchPlan(question, { user_id: 'global', category_id: categoryId });
    if (!planPair) {
      res.status(500).json({ error: { message: 'Failed to generate search plan' } });
      return;
    }
    const plan = planPair.normalized;

    const want = Math.min(20, Math.max(10, limit * 2));
    let chunks: Awaited<ReturnType<typeof runHybridSearch>> = [];
    if (plan.hybrid?.enabled) {
      chunks = await runHybridSearch(question, 'global', plan, { categoryId, limit: want, global: true });
      if (!chunks.length) {
        chunks = await runSemanticSearch(question, 'global', plan, { categoryId, global: true });
      }
    } else {
      chunks = await runSemanticSearch(question, 'global', plan, { categoryId, global: true });
    }

    const { posts, total } = aggregatePosts(chunks, { limit, offset });

    res.status(200).json({
      query: { question, category_id: categoryId, limit, offset },
      plan: {
        mode: plan.mode,
        top_k: plan.top_k,
        threshold: plan.threshold,
        weights: plan.weights,
        sort: plan.sort,
        limit: plan.limit,
        hybrid: plan.hybrid,
        time: (plan as any)?.filters?.time || null,
        rewrites_len: Array.isArray(plan.rewrites) ? plan.rewrites.length : 0,
        keywords_len: Array.isArray(plan.keywords) ? plan.keywords.length : 0,
      },
      total_posts: total,
      posts,
    });
  } catch (e: any) {
    res.status(500).json({ error: { message: e?.message || 'Internal server error' } });
  }
};
