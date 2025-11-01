import { PassThrough } from 'stream';
import { GenerateRequest } from './types';
import { getDefaultChat } from './model-registry';
import { generateOpenAIStream } from './providers/openai-responses';
import { generateGeminiStream } from './providers/gemini';
import { countChatMessagesTokens, countTextTokens } from '../utils/tokenizer';
import { calcCost, getModelPricing } from '../utils/cost';
import config from '../config';
import { randomUUID } from 'crypto';
import { DebugLogger } from '../utils/debug-logger';

// LLM 제공자별 스트림을 추상화하여 공통 SSE 포맷으로 반환
export const generate = async (req: GenerateRequest): Promise<PassThrough> => {
  const merged = { ...req };
  if (!merged.provider || !merged.model) {
    const def = getDefaultChat();
    merged.provider = merged.provider || def.provider;
    merged.model = merged.model || def.modelId;
  }

  const doLog = (config.LLM_COST_LOG || '').toString().toLowerCase() === 'true';
  const round = config.LLM_COST_ROUND ?? 4;
  const corrId = randomUUID();
  const model = merged.model as string;
  const provider = merged.provider as string;

  // 호출 전에 프롬프트 토큰 수와 예상 입력 비용을 기록
  const messages = merged.messages || [];
  let promptTokens = 0;
  try {
    promptTokens = countChatMessagesTokens(messages as any, model);
  } catch {
    // 무시
  }
  const pricing = getModelPricing(model);
  const estInputCost = pricing ? calcCost(promptTokens, pricing.input_per_1k) : 0;
  if (doLog) {
    const pre = {
      type: 'llm.request',
      corrId,
      provider,
      model,
      promptTokens,
      estInputCost,
      userId: merged.meta?.userId,
      categoryId: merged.meta?.categoryId,
      postId: merged.meta?.postId,
    };
    DebugLogger.log('llm', pre);
  }

  const startedAt = Date.now();

  const providerStream =
    merged.provider === 'openai'
      ? await generateOpenAIStream(merged)
      : merged.provider === 'gemini'
      ? await generateGeminiStream(merged)
      : (() => {
          const s = new PassThrough();
          s.write(`event: error\n`);
          s.write(`data: ${JSON.stringify({ message: 'Unknown provider' })}\n\n`);
          s.end();
          return s;
        })();

  // 공급자 스트림을 감싸 출력 토큰을 집계
  const outer = new PassThrough();
  let buffer = '';
  let outputText = '';

  // 디버그: 호출 시작 정보
  try {
    DebugLogger.log('llm', { type: 'debug.llm.start', provider, model, messages: (messages || []).length });
  } catch {}

  const flushBuffer = () => {
    // 두 줄바꿈을 기준으로 SSE 이벤트 단위로 분할
    const chunks = buffer.split('\n\n');
    // 마지막 미완성 조각은 버퍼에 보존
    buffer = chunks.pop() || '';
    for (const block of chunks) {
      const lines = block.split('\n');
      let evt: string | null = null;
      let dataLine: string | null = null;
      for (const line of lines) {
        if (line.startsWith('event:')) evt = line.slice(6).trim();
        if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      }
      if (evt === 'answer' && dataLine) {
        try {
          const parsed = JSON.parse(dataLine);
          if (typeof parsed === 'string') outputText += parsed;
          else outputText += JSON.stringify(parsed);
        } catch {
          outputText += dataLine;
        }
      }
      outer.write(block + '\n\n');
    }
  };

  providerStream.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer += str;
    flushBuffer();
  });
  providerStream.on('end', () => {
    if (buffer.length > 0) {
      outer.write(buffer);
      buffer = '';
    }

    const completionTokens = (() => {
      try {
        return countTextTokens(outputText, model);
      } catch {
        return 0;
      }
    })();
    const durationMs = Date.now() - startedAt;
    if (doLog) {
      const inputCost = pricing ? calcCost(promptTokens, pricing.input_per_1k) : 0;
      const outputCost = pricing ? calcCost(completionTokens, pricing.output_per_1k) : 0;
      const totalCost = inputCost + outputCost;
      const post = {
        type: 'llm.response',
        corrId,
        provider,
        model,
        promptTokens,
        completionTokens,
        inputCost,
        outputCost,
        totalCost,
        durationMs,
      };
      DebugLogger.log('llm', post);
    }
    try {
      DebugLogger.log('llm', {
        type: 'debug.llm.end',
        provider,
        model,
        durationMs,
        outputChars: outputText.length,
      });
    } catch {}
    outer.end();
  });
  providerStream.on('error', (e) => {
    if (doLog) {
      DebugLogger.log('llm', { type: 'llm.error', corrId, provider, model, message: (e as any)?.message || 'error' });
    }
    try {
      DebugLogger.error('llm', { type: 'debug.llm.error', provider, model, message: (e as any)?.message || 'error' });
    } catch {}
    outer.emit('error', e);
  });

  return outer;
};
