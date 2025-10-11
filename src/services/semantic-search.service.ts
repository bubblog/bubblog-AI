import { createEmbeddings } from './embedding.service';
import * as postRepository from '../repositories/post.repository';
import { SearchPlan } from '../types/ai.v2.types';

export type SemanticSearchResult = {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
  chunkIndex?: number;
  postCreatedAt?: string;
}[];

export const runSemanticSearch = async (
  question: string,
  userId: string,
  plan: SearchPlan,
  opts?: { categoryId?: number }
): Promise<SemanticSearchResult> => {
  const [embedding] = await createEmbeddings([question]);

  const from = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.from : undefined;
  const to = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.to : undefined;

  const rows = await postRepository.findSimilarChunksV2({
    userId,
    embedding,
    categoryId: opts?.categoryId,
    from,
    to,
    threshold: plan.threshold,
    topK: plan.top_k,
    weights: plan.weights,
    sort: plan.sort,
  });

  return rows;
};
