import { get_encoding } from '@dqbd/tiktoken';

const encodingForModel = (model: string): string => {
  const lower = (model || '').toLowerCase();
  if (lower.includes('gpt-5') || lower.includes('gpt-4o') || lower.includes('o1') || lower.includes('o3')) {
    return 'o200k_base';
  }
  return 'cl100k_base';
};

export const countTextTokens = (text: string, model: string): number => {
  const encKey = encodingForModel(model);
  const enc = get_encoding(encKey);
  try {
    const tokens = enc.encode(text || '');
    return tokens.length;
  } finally {
    // no explicit free in @dqbd/tiktoken browser build; safe to let GC handle
  }
};

type SimpleMessage = { role: string; content: string };

export const countChatMessagesTokens = (messages: SimpleMessage[], model: string): number => {
  // Approximate: sum content token counts + minimal role overhead
  const overheadPerMsg = 3; // rough
  const roleOverhead = 1;
  return messages.reduce((sum, m) => {
    return sum + countTextTokens(m.content || '', model) + overheadPerMsg + roleOverhead;
  }, 0);
};

