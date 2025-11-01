import { PassThrough } from 'stream';
import config from '../../config';
import { GenerateRequest } from '../types';

// 프로젝트 계획에 따라 @google/genai를 사용하며 호환성을 위해 타입을 느슨하게 유지
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GoogleGenAI } = require('@google/genai');

const buildPromptFromMessages = (messages: { role: string; content: string }[]) => {
  // 역할 정보를 유지한 채 단순 연결
  return messages
    .map((m) => `[${m.role}]\n${m.content}`)
    .join('\n\n');
};

// Gemini SDK를 호출해 응답 텍스트를 SSE로 분할
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

    // 먼저 동기 호출로 응답을 받고 이후 SSE 조각으로 분할
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

    // 응답 텍스트를 얻기 위한 여러 접근 경로를 시도
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
