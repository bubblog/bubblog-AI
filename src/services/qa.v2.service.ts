import { PassThrough } from 'stream';
import { generate } from '../llm';
import config from '../config';
import * as qaPrompts from '../prompts/qa.prompts';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import * as userRepository from '../repositories/user.repository';
import { generateSearchPlan } from './search-plan.service';
import { runSemanticSearch } from './semantic-search.service';
import { runHybridSearch } from './hybrid-search.service';
import { createEmbeddings } from './embedding.service';
import { DebugLogger } from '../utils/debug-logger';

const preprocessContent = (content: string): string => {
  const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plainText.length > 40000 ? plainText.substring(0, 40000) : plainText;
};

const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return '간결하고 명확한 말투로 답변해';
  if (speechTone === -2)
    return '아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해';

  const persona = await personaRepository.findPersonaById(speechTone, userId);
  if (persona) return `${persona.name}: ${persona.description}`;
  return '간결하고 명확한 말투로 답변해';
};

type LlmOverride = {
  provider?: 'openai' | 'gemini';
  model?: string;
  options?: { temperature?: number; top_p?: number; max_output_tokens?: number };
};

export const answerStreamV2 = async (
  question: string,
  userId: string,
  categoryId?: number,
  speechTone: number = -1,
  postId?: number,
  llm?: LlmOverride
): Promise<PassThrough> => {
  const stream = new PassThrough();

  (async () => {
    const [speechTonePrompt, blogMeta] = await Promise.all([
      getSpeechTonePrompt(speechTone, userId),
      userRepository.findUserBlogMetadata(userId),
    ]);

    let messages: { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] = [];
    let tools:
      | {
          type: 'function';
          function: { name: string; description?: string; parameters?: Record<string, unknown> };
        }[]
      | undefined = undefined;

    const toSimpleMessages = (
      raw: any[]
    ): { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] => {
      return (raw || []).map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    };

    if (postId) {
      // Post-centric path (same as v1 with added v2 pre-events)
      const post = await postRepository.findPostById(postId);
      if (!post) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 404, message: 'Post not found' })}\n\n`);
        stream.end();
        return;
      }
      if (!post.is_public && post.user_id !== userId) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
        stream.end();
        return;
      }
      // Emit plan event for transparency
      stream.write(`event: search_plan\n`);
      stream.write(
        `data: ${JSON.stringify({ mode: 'post', filters: { post_id: postId, user_id: userId } })}\n\n`
      );

      const processed = preprocessContent(post.content);
      const ctx = [{ postId: post.id, postTitle: post.title }];
      stream.write(`event: search_result\n`);
      stream.write(`data: ${JSON.stringify(ctx)}\n\n`);
      stream.write(`event: exist_in_post_status\n`);
      stream.write(`data: true\n\n`);
      stream.write(`event: context\n`);
      stream.write(`data: ${JSON.stringify(ctx)}\n\n`);

      messages = toSimpleMessages(
        qaPrompts.createPostContextPrompt(post, processed, question, speechTonePrompt, blogMeta ?? undefined)
      );
    } else {
      // Plan generation
      const planPair = await generateSearchPlan(question, { user_id: userId, category_id: categoryId });
      if (!planPair) {
        // Fallback to v1 RAG silently
        const [questionEmbedding] = await createEmbeddings([question]);
        const similarChunks = await postRepository.findSimilarChunks(userId, questionEmbedding, categoryId);
        const context = similarChunks.map((c) => ({ postId: c.postId, postTitle: c.postTitle }));
        stream.write(`event: search_plan\n`);
        stream.write(`data: ${JSON.stringify({ mode: 'rag', fallback: true })}\n\n`);
        stream.write(`event: search_result\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);
        stream.write(`event: exist_in_post_status\n`);
        stream.write(`data: ${JSON.stringify(similarChunks.length > 0)}\n\n`);
        stream.write(`event: context\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);

        const ragChunks = similarChunks.map((c) => ({
          postId: c.postId,
          postTitle: c.postTitle,
          postChunk: c.postChunk,
          createdAt: (c as any).postCreatedAt ?? null,
        }));
        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(question, ragChunks, speechTonePrompt, {
            retrievalMeta: {
              strategy: '임베딩 기반 RAG (검색 계획 생성 실패 폴백)',
              resultCount: similarChunks.length,
              notes: ['검색 계획 생성 실패로 기본 임베딩 검색을 사용했습니다.'],
            },
            blogMeta: blogMeta ?? undefined,
          })
        );
      } else {
        const plan: any = planPair.normalized;
        stream.write(`event: search_plan\n`);
        stream.write(`data: ${JSON.stringify(plan)}\n\n`);
        // Console debug for emitted search plan
        DebugLogger.log('sse', {
          type: 'debug.sse.search_plan',
          userId,
          categoryId,
          plan_summary: {
            mode: plan.mode,
            top_k: plan.top_k,
            threshold: plan.threshold,
            weights: plan.weights,
            sort: plan.sort,
            limit: plan.limit,
            hybrid: plan.hybrid,
            time: plan?.filters?.time || null,
            rewrites_len: Array.isArray(plan.rewrites) ? plan.rewrites.length : 0,
            keywords_len: Array.isArray(plan.keywords) ? plan.keywords.length : 0,
          },
        });

        let rows: {
          postId: string;
          postTitle: string;
          postChunk: string;
          similarityScore: number;
          postCreatedAt?: string;
          chunkIndex?: number;
        }[] = [];
        if (plan.hybrid?.enabled) {
          if (Array.isArray(plan.rewrites) && plan.rewrites.length > 0) {
            stream.write(`event: rewrite\n`);
            stream.write(`data: ${JSON.stringify(plan.rewrites)}\n\n`);
          }
          if (Array.isArray(plan.keywords) && plan.keywords.length > 0) {
            stream.write(`event: keywords\n`);
            stream.write(`data: ${JSON.stringify(plan.keywords)}\n\n`);
          }
          rows = await runHybridSearch(
            question,
            userId,
            plan,
            { categoryId: categoryId ?? undefined, limit: plan.limit }
          );
          const hybridContext = rows.map((r) => ({ postId: r.postId, postTitle: r.postTitle }));
          stream.write(`event: hybrid_result\n`);
          stream.write(`data: ${JSON.stringify(hybridContext)}\n\n`);
          // Optional enriched metadata for clients that opt-in
          try {
            const hybridMeta = rows.map((r) => ({
              postId: r.postId,
              postTitle: r.postTitle,
              chunkIndex: (r as any).chunkIndex ?? null,
              createdAt: (r as any).postCreatedAt ?? null,
            }));
            stream.write(`event: hybrid_result_meta\n`);
            stream.write(`data: ${JSON.stringify(hybridMeta)}\n\n`);
          } catch {}

          if (!rows.length) {
            rows = await runSemanticSearch(question, userId, plan, { categoryId: categoryId ?? undefined });
          }
        } else {
          rows = await runSemanticSearch(question, userId, plan, { categoryId: categoryId ?? undefined });
        }

        const context = rows.map((r) => ({ postId: r.postId, postTitle: r.postTitle }));
        stream.write(`event: search_result\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);
        // Optional enriched metadata for clients that opt-in
        try {
          const resultMeta = rows.map((r) => ({
            postId: r.postId,
            postTitle: r.postTitle,
            chunkIndex: (r as any).chunkIndex ?? null,
            createdAt: (r as any).postCreatedAt ?? null,
          }));
          stream.write(`event: search_result_meta\n`);
          stream.write(`data: ${JSON.stringify(resultMeta)}\n\n`);
        } catch {}
        stream.write(`event: exist_in_post_status\n`);
        stream.write(`data: ${JSON.stringify(rows.length > 0)}\n\n`);
        stream.write(`event: context\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);

        const planChunks = rows.map((r) => ({
          postId: r.postId,
          postTitle: r.postTitle,
          postChunk: r.postChunk,
          createdAt: r.postCreatedAt ?? null,
        }));
        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(question, planChunks, speechTonePrompt, {
            retrievalMeta: {
              strategy: plan.hybrid?.enabled
                ? `검색 계획 기반 하이브리드 (${plan.hybrid.retrieval_bias || 'balanced'})`
                : '검색 계획 기반 임베딩',
              plan,
              resultCount: rows.length,
            },
            blogMeta: blogMeta ?? undefined,
          })
        );
      }
    }

    const llmStream = await generate({
      provider: llm?.provider || 'openai',
      model: llm?.model || config.CHAT_MODEL,
      messages,
      tools,
      options: llm?.options,
      meta: { userId, categoryId, postId },
    });

    llmStream.on('data', (chunk) => stream.write(chunk));
    llmStream.on('end', () => stream.end());
    llmStream.on('error', () => {
      stream.write(`event: error\n`);
      stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.end();
    });
  })().catch((err) => {
    try {
      console.error('v2 Stream process error:', err);
    } catch {}
    stream.write(`event: error\n`);
    stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    stream.end();
  });

  return stream;
};
