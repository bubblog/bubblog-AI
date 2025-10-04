import { ProviderName } from './types';

type ModelEntry = {
  provider: ProviderName;
  modelId: string;
};

// Minimal registry for now; can expand with tokenizer/pricing later.
const DEFAULT_CHAT: ModelEntry = { provider: 'openai', modelId: 'gpt-5-mini' };

export const getDefaultChat = (): ModelEntry => DEFAULT_CHAT;

