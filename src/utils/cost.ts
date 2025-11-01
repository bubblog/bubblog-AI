export type Pricing = {
  input_per_1k: number;
  output_per_1k: number;
  cached_input_per_1k?: number;
  currency: 'USD' | 'KRW' | string;
};

const PRICING_TABLE: Record<string, Pricing> = {
  // OpenAI 요금표
  'gpt-5-mini': { input_per_1k: 0.00025, output_per_1k: 0.002, cached_input_per_1k: 0.000025, currency: 'USD' },
  'gpt-5-nano': { input_per_1k: 0.00005, output_per_1k: 0.0004, cached_input_per_1k: 0.000005, currency: 'USD' },
  'gpt-4o': { input_per_1k: 0.005, output_per_1k: 0.015, currency: 'USD' },
  'gpt-4o-mini': { input_per_1k: 0.0005, output_per_1k: 0.0015, currency: 'USD' },
  // 임베딩 모델 요금
  'text-embedding-3-small': { input_per_1k: 0.00002, output_per_1k: 0, currency: 'USD' },
  // Gemini (예시 값이므로 필요 시 공식 가격으로 갱신)
  'gemini-2.5-flash': { input_per_1k: 0.0001, output_per_1k: 0.0004, currency: 'USD' },
};

export const getModelPricing = (model: string): Pricing | null => {
  if (!model) return null;
  const key = model.toLowerCase();
  if (PRICING_TABLE[key]) return PRICING_TABLE[key];
  // 자주 쓰는 모델 별칭을 단순 매핑
  if (key.startsWith('gpt-4o')) return PRICING_TABLE['gpt-4o'];
  if (key.startsWith('gpt-5-mini')) return PRICING_TABLE['gpt-5-mini'];
  return null;
};

export const calcCost = (tokens: number, per_1k: number): number => {
  if (!per_1k) return 0;
  return (tokens / 1000) * per_1k;
};

export const formatCost = (amount: number, currency: string, round: number = 4): string => {
  const factor = Math.pow(10, Math.max(0, round));
  const rounded = Math.round(amount * factor) / factor;
  return `${rounded} ${currency}`;
};
