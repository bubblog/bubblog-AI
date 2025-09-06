import { createEmbeddings } from './embedding.service';
import { PassThrough } from 'stream';
import OpenAI from 'openai';
import config from '../config';
import * as postRepository from '../repositories/post.repository';
import * as personaRepository from '../repositories/persona.repository';
import * as qaPrompts from '../prompts/qa.prompts';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

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

export const answerStream = async (
  question: string,
  userId: string,
  categoryId?: number,
  speechTone: number = -1,
  postId?: number
): Promise<PassThrough> => {
  const stream = new PassThrough();

  let messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = undefined;

  (async () => {
    const speechTonePrompt = await getSpeechTonePrompt(speechTone, userId);

    if (postId) {
      const post = await postRepository.findPostById(postId);

      if (!post) {
        stream.write(`event: error\ndata: ${JSON.stringify({ code: 404, message: 'Post not found' })}\n\n`);
        stream.end();
        return;
      }

      if (post.user_id !== userId) {
         stream.write(`event: error\ndata: ${JSON.stringify({ code: 403, message: 'Forbidden' })}\n\n`);
         stream.end();
         return;
      }

      const processedContent = preprocessContent(post.content);
      stream.write(`event: exist_in_post_status\ndata: true\n\n`);
      stream.write(`event: context\ndata: ${JSON.stringify([{ postId: post.id, postTitle: post.title }])}\n\n`);

      messages = qaPrompts.createPostContextPrompt(post, processedContent, question, speechTonePrompt);

    } else {
      const [questionEmbedding] = await createEmbeddings([question]);
      const similarChunks = await postRepository.findSimilarChunks(userId, questionEmbedding, categoryId);
      
      const existInPost = similarChunks.length > 0;
      stream.write(`event: exist_in_post_status\ndata: ${JSON.stringify(existInPost)}\n\n`);

      const context = similarChunks.map(chunk => ({ postId: chunk.postId, postTitle: chunk.postTitle }));
      stream.write(`event: context\ndata: ${JSON.stringify(context)}\n\n`);

      messages = qaPrompts.createRagPrompt(question, similarChunks, speechTonePrompt);
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

    const responseStream = await openai.chat.completions.create({
      model: config.CHAT_MODEL,
      messages,
      tools,
      tool_choice: tools ? 'auto' : undefined,
      stream: true,
    });

    for await (const chunk of responseStream) {
      const content = chunk.choices[0]?.delta?.content || "";
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;

      if (toolCalls) {
        for (const toolCall of toolCalls) {
          if (toolCall.function?.arguments) {
            stream.write(`event: answer\ndata: ${JSON.stringify(toolCall.function.arguments)}\n\n`);
          }
        }
      } else if (content) {
        stream.write(`event: answer\ndata: ${JSON.stringify(content)}\n\n`);
      }

      if (chunk.choices[0]?.finish_reason) {
        stream.write(`event: end\ndata: [DONE]\n\n`);
        stream.end();
        break;
      }
    }

  })().catch(err => {
      console.error('Stream process error:', err);
      stream.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
      stream.end();
  });

  return stream;
};
