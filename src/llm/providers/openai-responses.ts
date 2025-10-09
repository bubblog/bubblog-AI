import { PassThrough } from 'stream';
import OpenAI from 'openai';
import config from '../../config';
import { GenerateRequest, OpenAIStyleMessage, OpenAIStyleTool } from '../types';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const toResponsesInput = (messages: OpenAIStyleMessage[] = []) => {
  // Convert simple chat-style messages to Responses API input format
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: m.content }],
  }));
};

export const generateOpenAIStream = async (req: GenerateRequest): Promise<PassThrough> => {
  const stream = new PassThrough();
  const model = req.model || 'gpt-5-mini';
  const messages = req.messages || [];
  const tools = (req.tools || []) as unknown as OpenAI.Responses.ResponseCreateParams['tools'];

  // For gpt-5-* prefer Responses API. For other models, fall back to Chat Completions streaming.
  const isGpt5Family = /(^|\b)gpt-5/i.test(model);

  try {
    if (isGpt5Family) {
      // Prefer Responses API streaming for gpt-5
      try {
        const responsesStream: any = await (openai as any).responses.stream({
          model,
          input: toResponsesInput(messages) as any,
          tools: tools as any,
          temperature: req.options?.temperature,
          top_p: req.options?.top_p,
          max_output_tokens: req.options?.max_output_tokens,
        });

        responsesStream.on('response.output_text.delta', (delta: string) => {
          if (delta) {
            stream.write(`event: answer\n`);
            stream.write(`data: ${JSON.stringify(delta)}\n\n`);
          }
        });

        // Stream tool-call arguments as answer chunks to maintain SSE shape
        responsesStream.on('response.tool_call.delta', (toolDelta: any) => {
          const argsDelta = toolDelta?.arguments_delta || toolDelta?.arguments || '';
          if (argsDelta) {
            stream.write(`event: answer\n`);
            stream.write(`data: ${JSON.stringify(argsDelta)}\n\n`);
          }
        });

        responsesStream.on('response.completed', () => {
          stream.write(`event: end\n`);
          stream.write(`data: [DONE]\n\n`);
          stream.end();
        });

        responsesStream.on('error', (e: any) => {
          stream.write(`event: error\n`);
          stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
          stream.end();
        });

        // Ensure the stream starts and we await its completion
        await responsesStream.done();
        return stream;
      } catch (e) {
        // Fallback to non-streaming Responses if streaming path fails
        try {
          const response = await openai.responses.create({
            model,
            input: toResponsesInput(messages) as any,
            // Avoid tools in non-streaming mode to ensure text output
            temperature: req.options?.temperature,
            top_p: req.options?.top_p,
            max_output_tokens: req.options?.max_output_tokens,
          });
          const text = (response as any).output_text ?? '';
          const answerText = typeof text === 'string' ? text : '';
          const fallbackText = (() => {
            try {
              const outputs = (response as any).output || [];
              if (Array.isArray(outputs) && outputs.length > 0) {
                const parts = outputs
                  .flatMap((o: any) => o.content || [])
                  .filter((c: any) => c.type === 'output_text')
                  .map((c: any) => c.text)
                  .join('');
                return parts || '';
              }
            } catch {
              // ignore
            }
            return '';
          })();
          const finalText = answerText || fallbackText;
          const chunkSize = 400;
          for (let i = 0; i < finalText.length; i += chunkSize) {
            const chunk = finalText.slice(i, i + chunkSize);
            stream.write(`event: answer\n`);
            stream.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          stream.write(`event: end\n`);
          stream.write(`data: [DONE]\n\n`);
          stream.end();
          return stream;
        } catch (e2) {
          // fall through to chat completions streaming below
        }
      }
    }

    // Chat Completions streaming as universal fallback
    const chatStream = await openai.chat.completions.create({
      model,
      messages: messages as any,
      tools: (req.tools as OpenAI.Chat.Completions.ChatCompletionTool[]) || undefined,
      tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
      stream: true,
      temperature: req.options?.temperature,
      top_p: req.options?.top_p,
      max_tokens: req.options?.max_output_tokens as any,
    });

    for await (const chunk of chatStream) {
      const content = chunk.choices[0]?.delta?.content || '';
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;

      if (toolCalls) {
        for (const toolCall of toolCalls) {
          if (toolCall.function?.arguments) {
            stream.write(`event: answer\n`);
            stream.write(`data: ${JSON.stringify(toolCall.function.arguments)}\n\n`);
          }
        }
      } else if (content) {
        stream.write(`event: answer\n`);
        stream.write(`data: ${JSON.stringify(content)}\n\n`);
      }

      if (chunk.choices[0]?.finish_reason) {
        stream.write(`event: end\n`);
        stream.write(`data: [DONE]\n\n`);
        stream.end();
        break;
      }
    }

    return stream;
  } catch (err) {
    stream.write(`event: error\n`);
    stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    stream.end();
    return stream;
  }
};
