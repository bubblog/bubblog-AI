import { PassThrough } from 'stream';
import OpenAI from 'openai';
import config from '../../config';
import { GenerateRequest, OpenAIStyleMessage, OpenAIStyleTool } from '../types';
import { DebugLogger } from '../../utils/debug-logger';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

const toResponsesInput = (messages: OpenAIStyleMessage[] = []) => {
  // 단순 채팅 메시지를 Responses API 입력 구조로 변환
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
};

const toResponsesTools = (tools: OpenAIStyleTool[] = []) => {
  // Chat Completions 형식의 툴 정의를 Responses API 형식으로 변환
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

// OpenAI Responses API를 사용해 SSE 스트림을 구성
export const generateOpenAIStream = async (req: GenerateRequest): Promise<PassThrough> => {
  const stream = new PassThrough();
  // 스트림 종료 후에도 쓰지 않도록 보호 장치 설정
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

  // gpt-5 계열은 Responses API를 우선 사용하고, 그 외 모델은 Chat Completions 스트리밍으로 폴백
  const isGpt5Family = /(^|\b)gpt-5/i.test(model);

  // 호출 기본 정보를 디버그 로그로 남김
  DebugLogger.log('openai', {
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
  });

  try {
    if (isGpt5Family) {
      // gpt-5 계열에서는 Responses API 스트리밍을 우선 사용
      try {
        const respParams: any = {
          model,
          input: toResponsesInput(messages) as any,
          tools: toolsChat && toolsChat.length > 0 ? toResponsesTools(toolsChat) : undefined,
          max_output_tokens: req.options?.max_output_tokens,
        };
        // GPT-5 계열은 temperature/top_p 없이 추론·텍스트 옵션만 전달
        if (req.options?.reasoning_effort) {
          respParams.reasoning = { effort: req.options.reasoning_effort };
        } else {
          // 기본값: 생각(추론) 강도를 최소화하여 지연을 줄임
          respParams.reasoning = { effort: 'minimal' };
        }
        if (req.options?.text_verbosity) {
          respParams.text = { verbosity: req.options.text_verbosity };
        } else {
          // 옵션이 없으면 텍스트 출력을 유도하기 위해 낮은 verbosity 지정
          respParams.text = { verbosity: 'low' };
        }
        DebugLogger.log('openai', {
          type: 'debug.openai.path',
          path: 'responses.stream',
          paramsKeys: Object.keys(respParams),
        });
        const responsesStream: any = await (openai as any).responses.stream(respParams);

        responsesStream.on('response.output_text.delta', (ev: any) => {
          const text = typeof ev === 'string' ? ev : ev?.delta ?? '';
          if (text) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(text)}\n\n`);
          }
        });

        // 툴 호출 인수 델타를 SSE 답변 이벤트로 전달
        responsesStream.on('response.tool_call.delta', (ev: any) => {
          const argsDelta = ev?.arguments_delta || ev?.arguments || ev?.delta || '';
          if (argsDelta) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(argsDelta)}\n\n`);
          }
        });
        // 델타가 아닌 툴 호출 이벤트도 동일하게 처리
        responsesStream.on('response.tool_call', (ev: any) => {
          const args = ev?.arguments || ev?.arguments_delta || '';
          if (args) {
            safeWrite(`event: answer\n`);
            safeWrite(`data: ${JSON.stringify(args)}\n\n`);
          }
        });

        // 기타 메시지를 포착해 다른 텍스트 이벤트를 놓치지 않도록 처리
        responsesStream.on('message', (msg: any) => {
          try {
            const m = typeof msg === 'string' ? JSON.parse(msg) : msg;
            if (!m) return;
            // output_text 델타가 있으면 우선 처리
            if (m.type === 'response.output_text.delta' && m.delta) {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.delta)}\n\n`);
            }
            // 일부 SDK는 전체 output_text를 한 번에 전송할 수 있음
            else if (m.type === 'response.output_text' && typeof m.text === 'string') {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.text)}\n\n`);
            }
            // 일반 델타 이벤트에 대한 폴백 처리
            else if (m.type === 'response.delta' && typeof m.delta === 'string') {
              safeWrite(`event: answer\n`);
              safeWrite(`data: ${JSON.stringify(m.delta)}\n\n`);
            }
            // 관찰을 위해 로그 남기기
            DebugLogger.log('openai', {
              type: 'debug.openai.msg',
              mtype: m.type,
              keys: Object.keys(m || {}),
            });
          } catch (e) {
            DebugLogger.log('openai', { type: 'debug.openai.msg_parse_error' });
          }
        });

        responsesStream.on('response.completed', () => {
          safeWrite(`event: end\n`);
          safeWrite(`data: [DONE]\n\n`);
          safeEnd();
          DebugLogger.log('openai', { type: 'debug.openai.completed' });
        });

        responsesStream.on('error', (e: any) => {
          safeWrite(`event: error\n`);
          safeWrite(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
          safeEnd();
          DebugLogger.error('openai', {
            type: 'debug.openai.error',
            path: 'responses.stream',
            message: (e as any)?.message,
          });
        });

        // 완료를 기다리지 않고 즉시 반환해 실시간 델타 소비를 허용
        (async () => {
          try {
            await responsesStream.done();
          } catch {}
        })();
        return stream;
      } catch (e) {
        // 스트리밍 경로가 실패하면 비스트리밍 Responses 호출로 폴백
        try {
          const createParams: any = {
            model,
            input: toResponsesInput(messages) as any,
            // 비스트리밍 모드에서는 텍스트 출력을 보장하기 위해 툴을 제외
            max_output_tokens: req.options?.max_output_tokens,
          };
          if (req.options?.reasoning_effort) createParams.reasoning = { effort: req.options.reasoning_effort };
          else createParams.reasoning = { effort: 'low' };
          if (req.options?.text_verbosity) createParams.text = { verbosity: req.options.text_verbosity };
          DebugLogger.log('openai', {
            type: 'debug.openai.path',
            path: 'responses.create',
            paramsKeys: Object.keys(createParams),
          });
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
              // 무시
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
          // 실패 시 아래 Chat Completions 스트리밍으로 폴백
          DebugLogger.error('openai', {
            type: 'debug.openai.error',
            path: 'responses.create',
            message: (e2 as any)?.message,
          });
        }
      }
    }

    // Chat Completions 스트리밍을 최종 폴백으로 사용
    DebugLogger.log('openai', { type: 'debug.openai.path', path: 'chat.completions.stream' });
    let chatStream: any;

    // 추론 모델(GPT-5 계열 등)은 temperature/top_p 옵션을 지원하지 않음
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
    
    // 비동기로 순회하며 즉시 반환하여 실시간 소비를 지원
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
            DebugLogger.log('openai', { type: 'debug.openai.completed', path: 'chat.completions.stream' });
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
    DebugLogger.error('openai', {
      type: 'debug.openai.error',
      path: 'top',
      message: (err as any)?.message,
      model,
      isGpt5Family,
    });
    return stream;
  }
};
