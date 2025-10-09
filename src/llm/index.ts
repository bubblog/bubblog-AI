import { PassThrough } from 'stream';
import { GenerateRequest } from './types';
import { getDefaultChat } from './model-registry';
import { generateOpenAIStream } from './providers/openai-responses';
import { generateGeminiStream } from './providers/gemini';
import { countChatMessagesTokens, countTextTokens } from '../utils/tokenizer';
import { calcCost, getModelPricing } from '../utils/cost';
import config from '../config';
import { randomUUID } from 'crypto';

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

  // Pre-call logging: prompt tokens + estimated input cost
  const messages = merged.messages || [];
  let promptTokens = 0;
  try {
    promptTokens = countChatMessagesTokens(messages as any, model);
  } catch {
    // ignore
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
    console.log(JSON.stringify(pre));
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

  // Wrap provider stream to accumulate output tokens
  const outer = new PassThrough();
  let buffer = '';
  let outputText = '';

  // Debug: start info
  try {
    console.log(
      JSON.stringify({ type: 'debug.llm.start', provider, model, messages: (messages || []).length })
    );
  } catch {}

  const flushBuffer = () => {
    // Split by double newline to get SSE events
    const chunks = buffer.split('\n\n');
    // Keep last partial
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
      console.log(JSON.stringify(post));
    }
    try {
      console.log(
        JSON.stringify({ type: 'debug.llm.end', provider, model, durationMs, outputChars: outputText.length })
      );
    } catch {}
    outer.end();
  });
  providerStream.on('error', (e) => {
    if (doLog) {
      console.log(
        JSON.stringify({ type: 'llm.error', corrId, provider, model, message: (e as any)?.message || 'error' })
      );
    }
    try {
      console.error(
        JSON.stringify({ type: 'debug.llm.error', provider, model, message: (e as any)?.message || 'error' })
      );
    } catch {}
    outer.emit('error', e);
  });

  return outer;
};
