import { createEmbeddings } from './embedding.service';
import { PassThrough } from 'stream';
import config from '../config';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import * as qaPrompts from '../prompts/qa.prompts';
import { generate } from '../llm';
import { DebugLogger } from '../utils/debug-logger';
import * as userRepository from '../repositories/user.repository';

// HTML 태그를 제거하고 길이를 제한하여 LLM 컨텍스트를 정제
const preprocessContent = (content: string): string => {
  const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plainText.length > 40000 ? plainText.substring(0, 40000) : plainText;
};

// 사용자 말투 ID에 따라 프롬프트 지시문을 반환
const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return "간결하고 명확한 말투로 답변해";
  if (speechTone === -2) return "아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해";

  const persona = await personaRepository.findPersonaById(speechTone, userId);

  if (persona) {
    return `${persona.name}: ${persona.description}`;
  }
  return "간결하고 명확한 말투로 답변해"; // 기본 말투
}

type LlmOverride = {
  provider?: 'openai' | 'gemini';
  model?: string;
  options?: { temperature?: number; top_p?: number; max_output_tokens?: number };
};

// 질문에 대한 RAG 답변을 SSE 스트림으로 생성
export const answerStream = async (
  question: string,
  userId: string,
  categoryId?: number,
  speechTone: number = -1,
  postId?: number,
  llm?: LlmOverride
): Promise<PassThrough> => {
  const stream = new PassThrough();
  DebugLogger.log('qa', {
    type: 'debug.qa.start',
    questionLen: question?.length || 0,
    userId,
    categoryId,
    postId,
    speechTone,
    llm,
  });

  let messages: { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] = [];
  let tools:
    | {
        type: 'function';
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      }[]
    | undefined = undefined;

  (async () => {
    const [speechTonePrompt, blogMeta] = await Promise.all([
      getSpeechTonePrompt(speechTone, userId),
      userRepository.findUserBlogMetadata(userId),
    ]);
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
        stream.end();
        DebugLogger.warn('qa', { type: 'debug.qa.post', status: 'not_found', postId });
        return;
      }
      
      // 비공개 글이면 소유자만 접근하도록 검증
      if (!post.is_public && post.user_id !== userId) {
        stream.write(`event: error\n`);
        stream.write(`data: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
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

    } else {
      const [questionEmbedding] = await createEmbeddings([question]);
      const similarChunks = await postRepository.findSimilarChunks(userId, questionEmbedding, categoryId);
      
      const existInPost = similarChunks.length > 0;
      stream.write(`event: exist_in_post_status\ndata: ${JSON.stringify(existInPost)}\n\n`);

      const context = similarChunks.map(chunk => ({ postId: chunk.postId, postTitle: chunk.postTitle }));
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
      messages = toSimpleMessages(
        qaPrompts.createRagPrompt(question, ragChunks, speechTonePrompt, {
          retrievalMeta: {
            strategy: categoryId
              ? `임베딩 기반 RAG (카테고리 ${categoryId})`
              : '임베딩 기반 RAG',
            resultCount: similarChunks.length,
          },
          blogMeta: blogMeta ?? undefined,
        })
      );
    }

    const llmStream = await generate({
      provider: llm?.provider || 'openai',
      model: llm?.model || config.CHAT_MODEL,
      messages,
      tools,
      options: llm?.options,
      meta: { userId, categoryId, postId },
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
      DebugLogger.log('qa', {
        type: 'debug.qa.chunk',
        at: Date.now(),
        bytes: Buffer.byteLength(str, 'utf8'),
        preview: str.slice(0, 40).replace(/\n/g, '\\n'),
      });
      stream.write(chunk);
    });
    llmStream.on('end', () => {
      stream.end();
    });
    llmStream.on('error', (e) => {
      DebugLogger.error('qa', { type: 'debug.qa.llmError', message: (e as any)?.message || 'error' });
    });

  })().catch(err => {
      console.error('Stream process error:', err);
      stream.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.end();
  });

  return stream;
};
