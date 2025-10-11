import { PassThrough } from 'stream';
import { generate } from '../llm';
import config from '../config';
import * as qaPrompts from '../prompts/qa.prompts';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import { generateSearchPlan } from './search-plan.service';
import { runSemanticSearch } from './semantic-search.service';
import { runHybridSearch } from './hybrid-search.service';
import { createEmbeddings } from './embedding.service';

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
    const speechTonePrompt = await getSpeechTonePrompt(speechTone, userId);

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
        qaPrompts.createPostContextPrompt(post, processed, question, speechTonePrompt)
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

        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(question, similarChunks, speechTonePrompt)
        );
        if (similarChunks.length === 0) {
          tools = undefined;
        } else {
          tools = [
            {
              type: 'function',
              function: {
                name: 'report_content_insufficient',
                description: '카테고리는 맞지만 본문 컨텍스트가 부족할 때 호출',
                parameters: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description:
                        '답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다.',
                    },
                  },
                  required: ['text'],
                },
              },
            },
          ];
        }
      } else {
        const plan: any = planPair.normalized;
        stream.write(`event: search_plan\n`);
        stream.write(`data: ${JSON.stringify(plan)}\n\n`);
        // Console debug for emitted search plan
        try {
          console.log(
            JSON.stringify(
              {
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
              },
              null,
              0,
            ),
          );
        } catch {}

        let rows: { postId: string; postTitle: string; postChunk: string; similarityScore: number }[] = [];
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
              score: r.similarityScore,
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
            score: r.similarityScore,
          }));
          stream.write(`event: search_result_meta\n`);
          stream.write(`data: ${JSON.stringify(resultMeta)}\n\n`);
        } catch {}
        stream.write(`event: exist_in_post_status\n`);
        stream.write(`data: ${JSON.stringify(rows.length > 0)}\n\n`);
        stream.write(`event: context\n`);
        stream.write(`data: ${JSON.stringify(context)}\n\n`);

        messages = toSimpleMessages(
          qaPrompts.createRagPrompt(
            question,
            rows.map((r) => ({
              postId: r.postId,
              postTitle: r.postTitle,
              postChunk: r.postChunk,
              similarityScore: r.similarityScore,
            })) as any,
            speechTonePrompt
          )
        );
        // If no context was found, avoid tool-calls to force direct natural-language guidance
        if (rows.length === 0) {
          tools = undefined;
        } else {
          tools = [
            {
              type: 'function',
              function: {
                name: 'report_content_insufficient',
                description: '카테고리는 맞지만 본문 컨텍스트가 부족할 때 호출',
                parameters: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description:
                        '답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다.',
                    },
                  },
                  required: ['text'],
                },
              },
            },
          ];
        }
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
