import { PassThrough } from 'stream';
import config from '../config';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import * as qaPrompts from '../prompts/qa.prompts';
import { generate } from '../llm';
import { DebugLogger } from '../utils/debug-logger';
import * as userRepository from '../repositories/user.repository';
import { createEmbeddings } from './embedding.service';
import * as sessionHistoryService from './session-history.service';
import { AskSession } from '../repositories/ask-session.repository';
import { extractAnswerText } from '../utils/sse';

// HTML 태그를 제거하고 길이를 제한하여 LLM 컨텍스트를 정제
const preprocessContent = (content: string): string => {
  const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plainText.length > 40000 ? plainText.substring(0, 40000) : plainText;
};

// 사용자 말투 ID에 따라 프롬프트 지시문을 반환
const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return '간결하고 명확한 말투로 답변해';
  if (speechTone === -2) return '아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해';

  const persona = await personaRepository.findPersonaById(speechTone, userId);

  if (persona) {
    return `${persona.name}: ${persona.description}`;
  }
  return '간결하고 명확한 말투로 답변해'; // 기본 말투
};

type LlmOverride = {
  provider?: 'openai' | 'gemini';
  model?: string;
  options?: { temperature?: number; top_p?: number; max_output_tokens?: number };
};

export interface AnswerStreamOptions {
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

// 질문에 대한 RAG 답변을 SSE 스트림으로 생성
export const answerStream = async ({
  question,
  session,
  requesterUserId,
  ownerUserId,
  categoryId,
  speechTone = -1,
  postId,
  llm,
}: AnswerStreamOptions): Promise<PassThrough> => {
  const stream = new PassThrough();
  DebugLogger.log('qa', {
    type: 'debug.qa.start',
    questionLen: question?.length || 0,
    ownerUserId,
    categoryId,
    postId,
    speechTone,
    llm,
    sessionId: session.id,
  });

  let messages: { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] = [];
  let tools:
    | {
        type: 'function';
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      }[]
    | undefined = undefined;

  let bufferedAnswer = '';
  let questionEmbedding: number[] | null = null;
  let searchPlanPayload: Record<string, unknown> | null = null;
  let retrievalMetaPayload: Record<string, unknown> | null = null;
  let clientDisconnected = false;

  const replayCachedAnswer = async (cached: sessionHistoryService.CachedAnswerResult) => {
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
    stream.write(`data: ${JSON.stringify(cached.answer)}\n\n`);

    try {
      if (!questionEmbedding) throw new Error('Missing question embedding for cache replay');
      await sessionHistoryService.persistConversation({
        sessionId: session.id,
        requesterUserId,
        ownerUserId,
        question,
        answer: cached.answer,
        searchPlan: cached.searchPlan ?? undefined,
        retrievalMeta: cached.retrievalMeta ?? undefined,
        categoryId,
        postId,
        questionEmbedding,
      });
      stream.emit('session_saved', sessionSavedPayload(session, true));
    } catch (error) {
      DebugLogger.error('qa', {
        type: 'debug.qa.cache_persistence_error',
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
    const embeddingVector = await createEmbeddings([question]);
    questionEmbedding = embeddingVector[0];

    const cachedAnswer =
      questionEmbedding &&
      (await sessionHistoryService.findCachedAnswer({
        ownerUserId,
        requesterUserId,
        embedding: questionEmbedding,
        postId: postId ?? undefined,
        categoryId: categoryId ?? undefined,
      }));

    if (cachedAnswer) {
      DebugLogger.log('qa', {
        type: 'debug.qa.cache_hit',
        sessionId: session.id,
        similarity: cachedAnswer.similarity,
      });
      await replayCachedAnswer(cachedAnswer);
      return;
    }

    const toSimpleMessages = (
      raw: any[]
    ): { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] => {
      return (raw || []).map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    };

    if (postId) {
      const post = await postRepository.findPostById(postId);

      if (!post) {
        stream.write(`event: error\ndata: ${JSON.stringify({ code: 404, message: 'Post not found' })}\n\n`);
        stream.emit('session_error', sessionErrorPayload(session, 'post_not_found'));
        stream.end();
        DebugLogger.warn('qa', { type: 'debug.qa.post', status: 'not_found', postId });
        return;
      }

      if (!post.is_public && post.user_id !== ownerUserId) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
        stream.emit('session_error', sessionErrorPayload(session, 'forbidden_post'));
        stream.end();
        DebugLogger.warn('qa', { type: 'debug.qa.post', status: 'forbidden', postId });
        return;
      }

      const processedContent = preprocessContent(post.content);
      stream.write(`event: exist_in_post_status\ndata: true\n\n`);
      stream.write(`event: context\ndata: ${JSON.stringify([{ postId: post.id, postTitle: post.title }])}\n\n`);
      DebugLogger.log('qa', {
        type: 'debug.qa.path',
        mode: 'post',
        postId: post.id,
        processedLen: processedContent.length,
      });

      messages = toSimpleMessages(
        qaPrompts.createPostContextPrompt(post, processedContent, question, speechTonePrompt, blogMeta ?? undefined)
      );

      searchPlanPayload = { mode: 'post', post_id: postId };
      retrievalMetaPayload = {
        strategy: '단일 포스트 컨텍스트',
        post_id: postId,
        context: [{ postId: post.id, postTitle: post.title }],
        exist_in_post_status: true,
      };
    } else {
      const similarChunks = await postRepository.findSimilarChunks(ownerUserId, questionEmbedding!, categoryId);

      const existInPost = similarChunks.length > 0;
      stream.write(`event: exist_in_post_status\ndata: ${JSON.stringify(existInPost)}\n\n`);

      const context = similarChunks.map((chunk) => ({ postId: chunk.postId, postTitle: chunk.postTitle }));
      stream.write(`event: context\ndata: ${JSON.stringify(context)}\n\n`);
      DebugLogger.log('qa', {
        type: 'debug.qa.path',
        mode: 'rag',
        similarChunks: similarChunks.length,
        contextPreview: context.slice(0, 3),
      });

      const ragChunks = similarChunks.map((chunk) => ({
        postId: chunk.postId,
        postTitle: chunk.postTitle,
        postChunk: chunk.postChunk,
        createdAt: (chunk as any).postCreatedAt ?? null,
      }));
      const retrievalMeta = {
        strategy: categoryId ? `임베딩 기반 RAG (카테고리 ${categoryId})` : '임베딩 기반 RAG',
        resultCount: similarChunks.length,
        context,
        exist_in_post_status: existInPost,
      };
      messages = toSimpleMessages(
        qaPrompts.createRagPrompt(question, ragChunks, speechTonePrompt, {
          retrievalMeta,
          blogMeta: blogMeta ?? undefined,
        })
      );

      searchPlanPayload = { mode: 'rag', category_id: categoryId ?? null };
      retrievalMetaPayload = retrievalMeta;
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
    DebugLogger.log('qa', {
      type: 'debug.qa.call',
      provider: llm?.provider || 'openai',
      model: llm?.model || config.CHAT_MODEL,
      messages: messages.length,
      tools: (tools || []).length,
      hasOptions: !!llm?.options,
    });

    llmStream.on('data', (chunk) => {
      const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const answerTexts = extractAnswerText(str);
      if (answerTexts.length) {
        bufferedAnswer += answerTexts.join('');
      }
      DebugLogger.log('qa', {
        type: 'debug.qa.chunk',
        at: Date.now(),
        bytes: Buffer.byteLength(str, 'utf8'),
        preview: str.slice(0, 40).replace(/\n/g, '\\n'),
      });
      stream.write(chunk);
    });

    llmStream.on('end', async () => {
      if (clientDisconnected) {
        stream.end();
        return;
      }
      DebugLogger.log('qa', {
        type: 'debug.qa.buffered_answer',
        sessionId: session.id,
        length: bufferedAnswer.length,
        preview: bufferedAnswer.slice(0, 80),
      });
      try {
        if (questionEmbedding) {
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
          });
          stream.emit('session_saved', sessionSavedPayload(session));
        } else {
          stream.emit('session_error', sessionErrorPayload(session, 'missing_question_embedding'));
        }
      } catch (error) {
        DebugLogger.error('qa', {
          type: 'debug.qa.persistence_error',
          message: (error as Error)?.message ?? 'unknown',
          sessionId: session.id,
        });
        stream.emit('session_error', sessionErrorPayload(session, 'persistence_failed'));
      }
      stream.end();
    });

    llmStream.on('error', (e) => {
      DebugLogger.error('qa', { type: 'debug.qa.llmError', message: (e as any)?.message || 'error' });
      stream.write(`event: error\n`);
      stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.emit('session_error', sessionErrorPayload(session, 'llm_error'));
      stream.end();
    });
  })().catch((err) => {
    console.error('Stream process error:', err);
    stream.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    stream.emit('session_error', sessionErrorPayload(session, 'stream_error'));
    stream.end();
  });

  return stream;
};
