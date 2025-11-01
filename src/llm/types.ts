export type ProviderName = 'openai' | 'gemini';

export type OpenAIStyleMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: string;
};

export type OpenAIStyleTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type GenerateRequest = {
  provider?: ProviderName;
  model?: string;
  messages?: OpenAIStyleMessage[];
  tools?: OpenAIStyleTool[];
  options?: {
    temperature?: number;
    top_p?: number;
    max_output_tokens?: number;
    // GPT-5 계열 전용 제어 옵션
    reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
    text_verbosity?: 'low' | 'medium' | 'high';
  };
  meta?: {
    userId?: string;
    categoryId?: number;
    postId?: number;
  };
};
