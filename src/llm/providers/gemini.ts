import { PassThrough } from 'stream';
import config from '../../config';
import { GenerateRequest } from '../types';

// Using @google/genai per project plan; keep types loose for compatibility
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenAI } = require('@google/genai');

const buildPromptFromMessages = (messages: { role: string; content: string }[]) => {
  // Simple concatenation preserving roles
  return messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join('\n\n');
};

export const generateGeminiStream = async (req: GenerateRequest): Promise<PassThrough> => {
  const stream = new PassThrough();
  try {
    const modelId = req.model || process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';
    const apiKey = (config as any).GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      stream.write(`event: error\n`);
      stream.write(`data: ${JSON.stringify({ message: 'Gemini API key not configured' })}\n\n`);
      stream.end();
      return stream;
    }

    const ai = new GoogleGenAI({ apiKey });

    const text = buildPromptFromMessages(req.messages || []);

    const generationConfig: any = {};
    if (req.options?.temperature != null) generationConfig.temperature = req.options.temperature;
    if (req.options?.top_p != null) generationConfig.topP = req.options.top_p;
    if (req.options?.max_output_tokens != null) generationConfig.maxOutputTokens = req.options.max_output_tokens;

    const thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET || '0', 10) || 0;
    const configBlock: any = thinkingBudget > 0 ? { thinkingConfig: { thinkingBudget } } : {};

    // Non-streaming first, then chunk SSE
    const result = await ai.models.generateContent({
      model: modelId,
      contents: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      generationConfig,
      config: configBlock,
    });

    // Try common text access paths
    const outputText = (result?.response?.text && result.response.text()) || (result?.text && result.text()) || '';

    const finalText = typeof outputText === 'string' ? outputText : '';

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
  } catch (err) {
    stream.write(`event: error\n`);
    stream.write(`data: ${JSON.stringify({ message: 'Internal server error' })}\n\n`);
    stream.end();
    return stream;
  }
};

