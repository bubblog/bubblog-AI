import { PassThrough } from 'stream';
import OpenAI from 'openai';
import config from '../../config';
import { GenerateRequest, OpenAIStyleMessage, OpenAIStyleTool } from '../types';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const toResponsesInput = (messages: OpenAIStyleMessage[] = []) => {
  // Convert simple chat-style messages to Responses API input format
  // Responses API expects 'input_text' as the content type (not 'text').
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: 'input_text', text: m.content }],
  }));
};

const toResponsesTools = (tools: OpenAIStyleTool[] = []) => {
  // Map Chat Completions style tool definitions to Responses API format
  // Chat: { type: 'function', function: { name, description, parameters } }
  // Responses: { type: 'function', name, description, parameters }
  return tools
    .filter((t) => t && (t as any).type === 'function' && (t as any).function?.name)
    .map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
};

export const generateOpenAIStream = async (req: GenerateRequest): Promise<PassThrough> => {
  const stream = new PassThrough();
  // Guard to avoid writing after stream end
  let closed = false;
  const safeWrite = (chunk: string) => {
    if (!closed && !stream.writableEnded && !stream.destroyed) {
      stream.write(chunk);
    }
  };
  const safeEnd = () => {
    if (!closed && !stream.writableEnded && !stream.destroyed) {
      closed = true;
      stream.end();
    } else {
      closed = true;
    }
  };
  const model = req.model || 'gpt-5-mini';
  const messages = req.messages || [];
  const toolsChat = (req.tools || []) as OpenAIStyleTool[];

  // For gpt-5-* prefer Responses API. For other models, fall back to Chat Completions streaming.
  const isGpt5Family = /(^|\b)gpt-5/i.test(model);

  // Debug: basic call info
  try {
    console.log(
      JSON.stringify({
        type: 'debug.openai.start',
        model,
        isGpt5Family,
        hasTools: Array.isArray(req.tools) && req.tools.length > 0,
        options: {
          temperature: req.options?.temperature,
          top_p: req.options?.top_p,
          max_output_tokens: req.options?.max_output_tokens,
          reasoning_effort: (req as any)?.options?.reasoning_effort,
          text_verbosity: (req as any)?.options?.text_verbosity,
        },
      })
    );
  } catch {}

  try {
    if (isGpt5Family) {
      // Prefer Responses API streaming for gpt-5
      try {
        const respParams: any = {
          model,
          input: toResponsesInput(messages) as any,
          tools: toolsChat && toolsChat.length > 0 ? toResponsesTools(toolsChat) : undefined,
          max_output_tokens: req.options?.max_output_tokens,
        };
        // GPT-5 family: omit temperature/top_p; allow reasoning/text controls
        if (req.options?.reasoning_effort) {
          respParams.reasoning = { effort: req.options.reasoning_effort };
        } else {
          // 기본값: 생각(추론) 강도를 최소화하여 지연을 줄임
          respParams.reasoning = { effort: 'minimal' };
        }
        if (req.options?.text_verbosity) {
          respParams.text = { verbosity: req.options.text_verbosity };
        } else {
          // Encourage text output on GPT-5 if not specified
          respParams.text = { verbosity: 'low' };
        }
        try {
          console.log(
            JSON.stringify({ type: 'debug.openai.path', path: 'responses.stream', paramsKeys: Object.keys(respParams) })
          );
        } catch {}
        const responsesStream: any = await (openai as any).responses.stream(respParams);

        // let loggedFirstDelta = false;
        responsesStream.on('response.output_text.delta', (ev: any) => {
          const text = typeof ev === 'string' ? ev : ev?.delta ?? '';
          if (text) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(text)}\n\n`);
            // try { console.log(JSON.stringify({ type: 'debug.openai.delta', len: String(text).length, at: Date.now() })); } catch {}
            // if (!loggedFirstDelta) {
              // try { console.log(JSON.stringify({ type: 'debug.openai.delta', len: String(text).length })); } catch {}
              // loggedFirstDelta = true;
            // }
          }
        });

        // Stream tool-call arguments as answer chunks to maintain SSE shape
        responsesStream.on('response.tool_call.delta', (ev: any) => {
          const argsDelta = ev?.arguments_delta || ev?.arguments || ev?.delta || '';
          if (argsDelta) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(argsDelta)}\n\n`);
          }
        });
        // Also handle non-delta tool_call events
        responsesStream.on('response.tool_call', (ev: any) => {
          const args = ev?.arguments || ev?.arguments_delta || '';
          if (args) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(args)}\n\n`);
          }
        });

        // Catch-all messages to ensure we don't miss alternative text events
        responsesStream.on('message', (msg: any) => {
          try {
            const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
            if (!m) return;
            // Prefer explicit output_text delta
            if (m.type === 'response.output_text.delta' && m.delta) {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.delta)}\n\n`);
            }
            // Some SDKs may emit full output_text chunk at once
            else if (m.type === 'response.output_text' && typeof m.text === 'string') {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.text)}\n\n`);
            }
            // Generic delta fallback
            else if (m.type === 'response.delta' && typeof m.delta === 'string') {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.delta)}\n\n`);
            }
            // Log for visibility
            console.log(
              JSON.stringify({ type: 'debug.openai.msg', mtype: m.type, keys: Object.keys(m || {}) })
            );
          } catch (e) {
            try { console.log(JSON.stringify({ type: 'debug.openai.msg_parse_error' })); } catch {}
          }
        });

        responsesStream.on('response.completed', () => {
          safeWrite(`event: end\n`);
          safeWrite(`data: [DONE]\n\n`);
          safeEnd();
          try { console.log(JSON.stringify({ type: 'debug.openai.completed' })); } catch {}
        });

        responsesStream.on('error', (e: any) => {
          safeWrite(`event: error\n`);
          safeWrite(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
          safeEnd();
          try {
            console.error(
              JSON.stringify({ type: 'debug.openai.error', path: 'responses.stream', message: (e as any)?.message })
            );
          } catch {}
        });

        // Do not await completion here; return immediately so callers can consume deltas in real-time
        (async () => {
          try {
            await responsesStream.done();
          } catch {}
        })();
        return stream;
      } catch (e) {
        // Fallback to non-streaming Responses if streaming path fails
        try {
          const createParams: any = {
            model,
            input: toResponsesInput(messages) as any,
            // Avoid tools in non-streaming mode to ensure text output
            max_output_tokens: req.options?.max_output_tokens,
          };
          if (req.options?.reasoning_effort) createParams.reasoning = { effort: req.options.reasoning_effort };
          else createParams.reasoning = { effort: 'low' };
          if (req.options?.text_verbosity) createParams.text = { verbosity: req.options.text_verbosity };
          try {
            console.log(
              JSON.stringify({ type: 'debug.openai.path', path: 'responses.create', paramsKeys: Object.keys(createParams) })
            );
          } catch {}
          const response = await openai.responses.create(createParams);
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
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          safeWrite(`event: end\n`);
          safeWrite(`data: [DONE]\n\n`);
          safeEnd();
          return stream;
        } catch (e2) {
          // fall through to chat completions streaming below
          try {
            console.error(
              JSON.stringify({ type: 'debug.openai.error', path: 'responses.create', message: (e2 as any)?.message })
            );
          } catch {}
        }
      }
    }

    // Chat Completions streaming as universal fallback
    try { console.log(JSON.stringify({ type: 'debug.openai.path', path: 'chat.completions.stream' })); } catch {}
    let chatStream: any;

    // temperature/top_p are not supported on reasoning models (e.g., GPT-5 family)
    if (!isGpt5Family) {
      chatStream = await openai.chat.completions.create({
        model,
        messages: messages as any,
        tools: (req.tools as OpenAI.Chat.Completions.ChatCompletionTool[]) || undefined,
        tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
        stream: true,
        temperature: req.options?.temperature,
        top_p: req.options?.top_p,
        max_tokens: req.options?.max_output_tokens as any,
      });
    } else {
      chatStream = await openai.chat.completions.create({
        model,
        messages: messages as any,
        tools: (req.tools as OpenAI.Chat.Completions.ChatCompletionTool[]) || undefined,
        tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
        stream: true,
        max_tokens: req.options?.max_output_tokens as any,
      });
    }
    
    // Iterate asynchronously; return stream immediately to allow real-time consumption
    (async () => {
      try {
        for await (const chunk of chatStream) {
          const content = chunk.choices[0]?.delta?.content || '';
          const toolCalls = chunk.choices[0]?.delta?.tool_calls;

          if (toolCalls) {
            for (const toolCall of toolCalls) {
              if (toolCall.function?.arguments) {
                safeWrite(`event: answer\n`);
                safeWrite(`data: ${JSON.stringify(toolCall.function.arguments)}\n\n`);
              }
            }
          } else if (content) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(content)}\n\n`);
          }

          if (chunk.choices[0]?.finish_reason) {
            safeWrite(`event: end\n`);
            safeWrite(`data: [DONE]\n\n`);
            safeEnd();
            try { console.log(JSON.stringify({ type: 'debug.openai.completed', path: 'chat.completions.stream' })); } catch {}
            break;
          }
        }
      } catch (e) {
        safeWrite(`event: error\n`);
        safeWrite(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
        safeEnd();
      }
    })();

    return stream;
  } catch (err) {
    safeWrite(`event: error\n`);
    safeWrite(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    safeEnd();
    try {
      console.error(
        JSON.stringify({ type: 'debug.openai.error', path: 'top', message: (err as any)?.message, model, isGpt5Family })
      );
    } catch {}
    return stream;
  }
};
