import { PassThrough } from 'stream';
import { GenerateRequest } from './types';
import { getDefaultChat } from './model-registry';
import { generateOpenAIStream } from './providers/openai-responses';
import { generateGeminiStream } from './providers/gemini';

export const generate = async (req: GenerateRequest): Promise<PassThrough> => {
  const merged = { ...req };
  if (!merged.provider || !merged.model) {
    const def = getDefaultChat();
    merged.provider = merged.provider || def.provider;
    merged.model = merged.model || def.modelId;
  }

  if (merged.provider === 'openai') {
    return generateOpenAIStream(merged);
  }

  if (merged.provider === 'gemini') {
    return generateGeminiStream(merged);
  }

  const stream = new PassThrough();
  stream.write(`event: error\n`);
  stream.write(`data: ${JSON.stringify({ message: 'Unknown provider' })}\n\n`);
  stream.end();
  return stream;
};
