export type Pricing = {
  input_per_1k: number;
  output_per_1k: number;
  cached_input_per_1k?: number;
  currency: 'USD' | 'KRW' | string;
};

const PRICING_TABLE: Record<string, Pricing> = {
  // OpenAI
  'gpt-5-mini': { input_per_1k: 0.00025, output_per_1k: 0.002, cached_input_per_1k: 0.000025, currency: 'USD' },
  'gpt-5-nano': { input_per_1k: 0.00005, output_per_1k: 0.0004, cached_input_per_1k: 0.000005, currency: 'USD' },
  'gpt-4o': { input_per_1k: 0.005, output_per_1k: 0.015, currency: 'USD' },
  'gpt-4o-mini': { input_per_1k: 0.0005, output_per_1k: 0.0015, currency: 'USD' },
  // Embeddings
  'text-embedding-3-small': { input_per_1k: 0.00002, output_per_1k: 0, currency: 'USD' },
  // Gemini (example values — update per official pricing if needed)
  'gemini-2.5-flash': { input_per_1k: 0.0001, output_per_1k: 0.0004, currency: 'USD' },
};

export const getModelPricing = (model: string): Pricing | null => {
  if (!model) return null;
  const key = model.toLowerCase();
  if (PRICING_TABLE[key]) return PRICING_TABLE[key];
  // naive aliasing for common variants
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

