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

// 벡터 임베딩만 사용하여 유사 청크를 조회
export const runSemanticSearch = async (
  question: string,
  userId: string,
  plan: SearchPlan,
  opts?: { categoryId?: number; global?: boolean }
): Promise<SemanticSearchResult> => {
  const [embedding] = await createEmbeddings([question]);

  const from = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.from : undefined;
  const to = (plan.filters as any)?.time?.type === 'absolute' ? (plan.filters as any).time.to : undefined;

  const rows = opts?.global
    ? await postRepository.findSimilarChunksGlobalANN({
        embedding,
        threshold: plan.threshold,
        topK: plan.top_k * 5,
        weights: plan.weights,
        sort: plan.sort,
        annFactor: 5,
      })
    : await postRepository.findSimilarChunksV2({
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
