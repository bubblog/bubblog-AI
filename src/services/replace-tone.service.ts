import config from '../config';
import { generate } from '../llm';
import { extractAnswerText } from '../utils/sse';
import type { LlmOverride } from '../types/llm.types';

const SYSTEM_PROMPT =
  '주어진 원문을 말투에 맞게 변경해라. 아래 콘텐츠 원문의 의미, 사실, 구조를 훼손하지 말고, 요청된 tone 지시만 반영해 다시 작성해.';
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 1.5;

const collectAnswerFromStream = (stream: NodeJS.ReadableStream): Promise<string> => {
  return new Promise((resolve, reject) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const texts = extractAnswerText(str);
      if (texts.length) buffer += texts.join('');
    });
    stream.on('end', () => resolve(buffer.trim()));
    stream.on('error', (err) => reject(err));
  });
};

export interface RewriteToneOptions {
  speechToneId: number;
  speechTonePrompt: string;
  llm?: LlmOverride;
}

export const rewriteTone = async (answer: string, opts: RewriteToneOptions): Promise<string> => {
  const original = (answer ?? '').trim();
  if (!original) throw new Error('tone_rewrite_original_empty');

  const provider = opts.llm?.provider || 'openai';
  const model = opts.llm?.model || config.CHAT_MODEL;
  const options = { ...(opts.llm?.options || {}) };
  if (typeof options.temperature !== 'number') {
    options.temperature = 0.2;
  }
  if (typeof options.top_p !== 'number') {
    options.top_p = 0.9;
  }
  const approxTokens = Math.max(120, Math.min(4096, Math.ceil(original.length * 1.2)));
  if (typeof options.max_output_tokens !== 'number') {
    options.max_output_tokens = approxTokens;
  }

  const stream = await generate({
    provider,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `tone 지시: ${opts.speechTonePrompt}\n원문: ${original}`,
      },
    ],
    options,
  });

  const rewritten = await collectAnswerFromStream(stream);
  if (!rewritten) throw new Error('tone_rewrite_empty');

  const ratio = rewritten.length / Math.max(1, original.length);
  if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
    throw new Error('tone_rewrite_ratio_out_of_bounds');
  }

  return rewritten;
};
