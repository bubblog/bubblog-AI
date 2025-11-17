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
import * as sessionHistoryService from './session-history.service';
import { AskSession } from '../repositories/ask-session.repository';
import { extractAnswerText } from '../utils/sse';
import { rewriteTone } from './replace-tone.service';
import type { LlmOverride } from '../types/llm.types';

// HTML을 제거하고 길이를 제한해 LLM 컨텍스트를 정리
const preprocessContent = (content: string): string => {
  const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plainText.length > 40000 ? plainText.substring(0, 40000) : plainText;
};

// 말투 ID나 프리셋에 따른 지시문을 구성
const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return '간결하고 명확한 말투로 답변해';
  if (speechTone === -2)
    return '아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해';

  const persona = await personaRepository.findPersonaById(speechTone, userId);
  if (persona) return `${persona.name}: ${persona.description}`;
  return '간결하고 명확한 말투로 답변해';
};

export interface AnswerStreamV2Options {
  question: string;
  session: AskSession;
  requesterUserId: string;
  ownerUserId: string;
  categoryId?: number;
  speechTone?: number;
  postId?: number;
  llm?: LlmOverride;
}

const prependHistory = (
  base: { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[],
  history: { role: 'user' | 'assistant'; content: string }[]
) => {
  if (!history.length) return base;
  if (base.length === 0 || base[0].role !== 'system') {
    return [...history, ...base];
  }
  const [systemMessage, ...rest] = base;
  return [systemMessage, ...history, ...rest];
};

const sessionSavedPayload = (session: AskSession, cached = false) => ({
  session_id: String(session.id),
  owner_user_id: session.ownerUserId,
  requester_user_id: session.requesterUserId,
  cached,
});

const sessionErrorPayload = (session: AskSession, reason: string) => ({
  session_id: String(session.id),
  owner_user_id: session.ownerUserId,
  requester_user_id: session.requesterUserId,
  reason,
});

// 검색 계획을 활용한 v2 QA 스트림을 생성
export const answerStreamV2 = async ({
  question,
  session,
  requesterUserId,
  ownerUserId,
  categoryId,
  speechTone = -1,
  postId,
  llm,
}: AnswerStreamV2Options): Promise<PassThrough> => {
  const stream = new PassThrough();

  let bufferedAnswer = '';
  let searchPlanPayload: Record<string, unknown> | null = null;
  let retrievalMetaPayload: Record<string, unknown> | null = null;
  let questionEmbedding: number[] | null = null;
  let duplicateQuestionEmbedding: number[] | null = null;
  let clientDisconnected = false;

  const replayCachedAnswer = async (
    cached: sessionHistoryService.CachedAnswerResult,
    options?: { answerOverride?: string; speechToneIdOverride?: number }
  ) => {
    const finalAnswer = options?.answerOverride ?? cached.answer;
    const speechToneForPersistence =
      typeof options?.speechToneIdOverride === 'number' ? options.speechToneIdOverride : cached.speechToneId;
    if (cached.searchPlan) {
      stream.write(`event: search_plan\n`);
      stream.write(`data: ${JSON.stringify(cached.searchPlan)}\n\n`);
    }
    const context = Array.isArray((cached.retrievalMeta as any)?.context)
      ? (cached.retrievalMeta as any).context
      : null;
    if (context) {
      stream.write(`event: search_result\n`);
      stream.write(`data: ${JSON.stringify(context)}\n\n`);
      stream.write(`event: context\n`);
      stream.write(`data: ${JSON.stringify(context)}\n\n`);
    }
    const existFlag = (cached.retrievalMeta as any)?.exist_in_post_status;
    if (typeof existFlag === 'boolean') {
      stream.write(`event: exist_in_post_status\n`);
      stream.write(`data: ${JSON.stringify(existFlag)}\n\n`);
    }
    stream.write(`event: answer\n`);
    stream.write(`data: ${JSON.stringify(finalAnswer)}\n\n`);

    try {
      if (!questionEmbedding || !duplicateQuestionEmbedding)
        throw new Error('Missing embeddings for cache replay');
      await sessionHistoryService.persistConversation({
        sessionId: session.id,
        requesterUserId,
        ownerUserId,
        question,
        answer: finalAnswer,
        searchPlan: cached.searchPlan ?? undefined,
        retrievalMeta: cached.retrievalMeta ?? undefined,
        categoryId,
        postId,
        questionEmbedding,
        duplicateQuestionEmbedding,
        speechTone: speechToneForPersistence,
      });
      stream.emit('session_saved', sessionSavedPayload(session, true));
    } catch (error) {
      DebugLogger.error('qa', {
        type: 'debug.qa.v2.cache_persistence_error',
        sessionId: session.id,
        message: (error as Error)?.message ?? 'unknown',
      });
      stream.emit('session_error', sessionErrorPayload(session, 'persistence_failed'));
    }
    stream.end();
  };

  stream.once('client_disconnect', () => {
    clientDisconnected = true;
  });

  (async () => {
    const [speechTonePrompt, blogMeta, historyMessages] = await Promise.all([
      getSpeechTonePrompt(speechTone, ownerUserId),
      userRepository.findUserBlogMetadata(ownerUserId),
      sessionHistoryService.loadRecentMessages(session.id),
    ]);
    const duplicateQuestionBlock = sessionHistoryService.buildDuplicateQuestionBlock(question, historyMessages);
    const embeddingVector = await createEmbeddings([question, duplicateQuestionBlock]);
    questionEmbedding = embeddingVector[0];
    duplicateQuestionEmbedding = embeddingVector[1];

    const cachedAnswerList = duplicateQuestionEmbedding
      ? await sessionHistoryService.findCachedAnswer({
          ownerUserId,
          embedding: duplicateQuestionEmbedding,
          postId: postId ?? undefined,
          categoryId: categoryId ?? undefined,
        })
      : [];

    const requestedSpeechTone = typeof speechTone === 'number' ? speechTone : -1;
    const { matchingCandidate: matchingCachedAnswer, rewriteCandidate } =
      sessionHistoryService.selectToneAwareCacheCandidate(cachedAnswerList, requestedSpeechTone);
    DebugLogger.log('qa', {
      type: 'debug.qa.v2.cache_candidates',
      requestedSpeechTone,
      candidateCount: cachedAnswerList.length,
      candidateTones: cachedAnswerList.map((candidate) => candidate.speechToneId),
    });

    if (matchingCachedAnswer) {
      DebugLogger.log('qa', {
        type: 'debug.qa.v2.cache_hit',
        sessionId: session.id,
        similarity: matchingCachedAnswer.similarity,
        speechTone: requestedSpeechTone,
      });
      await replayCachedAnswer(matchingCachedAnswer);
      return;
    }

    if (rewriteCandidate) {
      DebugLogger.log('qa', {
        type: 'debug.qa.v2.cache_hit_tone_mismatch',
        sessionId: session.id,
        similarity: rewriteCandidate.similarity,
        requestedSpeechTone,
        cachedSpeechTone: rewriteCandidate.speechToneId,
      });
      try {
        const rewrittenAnswer = await rewriteTone(rewriteCandidate.answer, {
          speechToneId: requestedSpeechTone,
          speechTonePrompt,
          llm,
        });
        await replayCachedAnswer(rewriteCandidate, {
          answerOverride: rewrittenAnswer,
          speechToneIdOverride: requestedSpeechTone,
        });
        return;
      } catch (error) {
        DebugLogger.warn('qa', {
          type: 'debug.qa.v2.cache_tone_rewrite_failed',
          sessionId: session.id,
          message: (error as Error)?.message ?? 'tone_rewrite_failed',
        });
      }
    }

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
      // 단일 포스트 컨텍스트 흐름 (v1과 동일하되 v2 이벤트 추가)
      const post = await postRepository.findPostById(postId);
      if (!post) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 404, message: 'Post not found' })}\n\n`);
        stream.emit('session_error', sessionErrorPayload(session, 'post_not_found'));
        stream.end();
        return;
      }
      if (!post.is_public && post.user_id !== ownerUserId) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
        stream.emit('session_error', sessionErrorPayload(session, 'forbidden_post'));
        stream.end();
        return;
      }
      // 검색 계획 정보를 스트림으로 먼저 공지
      const postPlan = { mode: 'post', filters: { post_id: postId, user_id: ownerUserId } };
      stream.write(`event: search_plan\n`);
      stream.write(`data: ${JSON.stringify(postPlan)}\n\n`);

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

      searchPlanPayload = postPlan;
      retrievalMetaPayload = {
        strategy: '단일 포스트 컨텍스트',
        post_id: postId,
        context: ctx,
        exist_in_post_status: true,
      };
    } else {
      // 질문 기반 검색 계획 생성 경로
      const planPair = await generateSearchPlan(question, { user_id: ownerUserId, category_id: categoryId });
      if (!planPair) {
        // 계획 생성 실패 시 v1 RAG로 조용히 폴백
        const similarChunks = await postRepository.findSimilarChunks(ownerUserId, questionEmbedding, categoryId);
        const context = similarChunks.map((c) => ({ postId: c.postId, postTitle: c.postTitle }));
        const fallbackPlan = { mode: 'rag', fallback: true };
        stream.write(`event: search_plan\n`);
        stream.write(`data: ${JSON.stringify(fallbackPlan)}\n\n`);
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
        const retrievalMeta = {
          strategy: '임베딩 기반 RAG (검색 계획 폴백)',
          resultCount: similarChunks.length,
          context,
          exist_in_post_status: similarChunks.length > 0,
        };
        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(question, ragChunks, speechTonePrompt, {
            retrievalMeta,
            blogMeta: blogMeta ?? undefined,
          })
        );
        searchPlanPayload = fallbackPlan;
        retrievalMetaPayload = retrievalMeta;
      } else {
        const plan: any = planPair.normalized;
        searchPlanPayload = plan;
        stream.write(`event: search_plan\n`);
        stream.write(`data: ${JSON.stringify(plan)}\n\n`);
        // 전송된 검색 계획을 디버그 로그로 남김
        DebugLogger.log('sse', {
          type: 'debug.sse.search_plan',
          userId: ownerUserId,
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
            ownerUserId,
            plan,
            { categoryId: categoryId ?? undefined, limit: plan.limit }
          );
          const hybridContext = rows.map((r) => ({ postId: r.postId, postTitle: r.postTitle }));
          stream.write(`event: hybrid_result\n`);
          stream.write(`data: ${JSON.stringify(hybridContext)}\n\n`);
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
            rows = await runSemanticSearch(question, ownerUserId, plan, { categoryId: categoryId ?? undefined });
          }
        } else {
          rows = await runSemanticSearch(question, ownerUserId, plan, { categoryId: categoryId ?? undefined });
        }

        const context = rows.map((r) => ({ postId: r.postId, postTitle: r.postTitle }));
        stream.write(`event: search_result\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);
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
        const retrievalMeta = {
          strategy: plan.hybrid?.enabled
            ? `검색 계획 기반 하이브리드 (${plan.hybrid.retrieval_bias || 'balanced'})`
            : '검색 계획 기반 임베딩',
          plan,
          resultCount: rows.length,
          context,
          exist_in_post_status: rows.length > 0,
        };
        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(question, planChunks, speechTonePrompt, {
            retrievalMeta,
            blogMeta: blogMeta ?? undefined,
          })
        );
        retrievalMetaPayload = retrievalMeta;
      }
    }

    const historyForPrompt = historyMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })) as { role: 'user' | 'assistant'; content: string }[];
    messages = prependHistory(messages, historyForPrompt);

    const llmStream = await generate({
      provider: llm?.provider || 'openai',
      model: llm?.model || config.CHAT_MODEL,
      messages,
      tools,
      options: llm?.options,
      meta: { userId: ownerUserId, categoryId, postId },
    });

    llmStream.on('data', (chunk) => {
      const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const answerTexts = extractAnswerText(str);
      if (answerTexts.length) {
        bufferedAnswer += answerTexts.join('');
      }
      stream.write(chunk);
    });
    llmStream.on('end', async () => {
      if (clientDisconnected) {
        stream.end();
        return;
      }
      DebugLogger.log('qa', {
        type: 'debug.qa.v2.buffered_answer',
        sessionId: session.id,
        length: bufferedAnswer.length,
        preview: bufferedAnswer.slice(0, 80),
      });
      try {
        if (questionEmbedding && duplicateQuestionEmbedding) {
          await sessionHistoryService.persistConversation({
            sessionId: session.id,
            requesterUserId,
            ownerUserId,
            question,
            answer: bufferedAnswer.trim(),
            searchPlan: searchPlanPayload ?? undefined,
            retrievalMeta: retrievalMetaPayload ?? undefined,
            categoryId,
            postId,
            questionEmbedding,
            duplicateQuestionEmbedding,
            speechTone,
          });
          stream.emit('session_saved', sessionSavedPayload(session));
        } else {
          stream.emit('session_error', sessionErrorPayload(session, 'missing_question_embedding'));
        }
      } catch (error) {
        DebugLogger.error('qa', {
          type: 'debug.qa.v2.persistence_error',
          message: (error as Error)?.message ?? 'unknown',
          sessionId: session.id,
        });
        stream.emit('session_error', sessionErrorPayload(session, 'persistence_failed'));
      }
      stream.end();
    });
    llmStream.on('error', () => {
      stream.write(`event: error\n`);
      stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.emit('session_error', sessionErrorPayload(session, 'llm_error'));
      stream.end();
    });
  })().catch((err) => {
    try {
      console.error('v2 Stream process error:', err);
    } catch {}
    stream.write(`event: error\n`);
    stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    stream.emit('session_error', sessionErrorPayload(session, 'stream_error'));
    stream.end();
  });

  return stream;
};
