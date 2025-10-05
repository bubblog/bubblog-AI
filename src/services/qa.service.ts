import { createEmbeddings } from './embedding.service';
import { PassThrough } from 'stream';
import config from '../config';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import * as qaPrompts from '../prompts/qa.prompts';
import { generate } from '../llm';

const preprocessContent = (content: string): string => {
  const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plainText.length > 40000 ? plainText.substring(0, 40000) : plainText;
};

const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return "간결하고 명확한 말투로 답변해";
  if (speechTone === -2) return "아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해";

  const persona = await personaRepository.findPersonaById(speechTone, userId);

  if (persona) {
    return `${persona.name}: ${persona.description}`;
  }
  return "간결하고 명확한 말투로 답변해"; // Default
}

type LlmOverride = {
  provider?: 'openai' | 'gemini';
  model?: string;
  options?: { temperature?: number; top_p?: number; max_output_tokens?: number };
};

export const answerStream = async (
  question: string,
  userId: string,
  categoryId?: number,
  speechTone: number = -1,
  postId?: number,
  llm?: LlmOverride
): Promise<PassThrough> => {
  const stream = new PassThrough();
  try {
    console.log(
      JSON.stringify({ type: 'debug.qa.start', questionLen: question?.length || 0, userId, categoryId, postId, speechTone, llm })
    );
  } catch {}

  let messages: { role: 'system' | 'user' | 'assistant' | 'tool' | 'function'; content: string }[] = [];
  let tools:
    | {
        type: 'function';
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      }[]
    | undefined = undefined;

  (async () => {
    const speechTonePrompt = await getSpeechTonePrompt(speechTone, userId);
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
        try { console.warn(JSON.stringify({ type: 'debug.qa.post', status: 'not_found', postId })); } catch {}
        return;
      }

      if (post.user_id !== userId) {
         stream.write(`event: error\ndata: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
         stream.end();
         try { console.warn(JSON.stringify({ type: 'debug.qa.post', status: 'forbidden', postId })); } catch {}
         return;
      }

      const processedContent = preprocessContent(post.content);
      stream.write(`event: exist_in_post_status\ndata: true\n\n`);
      stream.write(`event: context\ndata: ${JSON.stringify([{ postId: post.id, postTitle: post.title }])}\n\n`);
      try {
        console.log(
          JSON.stringify({ type: 'debug.qa.path', mode: 'post', postId: post.id, processedLen: processedContent.length })
        );
      } catch {}

      messages = toSimpleMessages(
        qaPrompts.createPostContextPrompt(post, processedContent, question, speechTonePrompt)
      );

    } else {
      const [questionEmbedding] = await createEmbeddings([question]);
      const similarChunks = await postRepository.findSimilarChunks(userId, questionEmbedding, categoryId);
      
      const existInPost = similarChunks.length > 0;
      stream.write(`event: exist_in_post_status\ndata: ${JSON.stringify(existInPost)}\n\n`);

      const context = similarChunks.map(chunk => ({ postId: chunk.postId, postTitle: chunk.postTitle }));
      stream.write(`event: context\ndata: ${JSON.stringify(context)}\n\n`);
      try {
        console.log(
          JSON.stringify({ type: 'debug.qa.path', mode: 'rag', similarChunks: similarChunks.length, contextPreview: context.slice(0, 3) })
        );
      } catch {}

      messages = toSimpleMessages(
        qaPrompts.createRagPrompt(question, similarChunks, speechTonePrompt)
      );
      tools = [
          {
            type: "function",
            function: {
              name: "report_content_insufficient",
              description: "카테고리는 맞지만 본문 컨텍스트가 부족할 때 호출",
              parameters: {
                type: "object",
                properties: {
                  text: { type: "string", description: "답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다." },
                },
                required: ["text"],
              },
            },
          },
      ];
    }

    const llmStream = await generate({
      provider: llm?.provider || 'openai',
      model: llm?.model || config.CHAT_MODEL,
      messages,
      tools,
      options: llm?.options,
      meta: { userId, categoryId, postId },
    });
    try {
      console.log(
        JSON.stringify({
          type: 'debug.qa.call',
          provider: llm?.provider || 'openai',
          model: llm?.model || config.CHAT_MODEL,
          messages: messages.length,
          tools: (tools || []).length,
          hasOptions: !!llm?.options,
        })
      );
    } catch {}

    llmStream.on('data', (chunk) => {
      stream.write(chunk);
    });
    llmStream.on('end', () => {
      stream.end();
    });
    llmStream.on('error', (e) => {
      try { console.error(JSON.stringify({ type: 'debug.qa.llmError', message: (e as any)?.message || 'error' })); } catch {}
    });

  })().catch(err => {
      console.error('Stream process error:', err);
      stream.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.end();
  });

  return stream;
};
