export type RetrievalBias = 'lexical' | 'balanced' | 'semantic';

export type RetrievalPreset = {
  alpha: number;
  sem_boost_threshold: number; // 정규화된 벡터 유사도 임계값
  lex_boost_threshold: number; // 정규화된 텍스트 유사도 임계값
};

export const RETRIEVAL_BIAS_PRESETS: Record<RetrievalBias, RetrievalPreset> = {
  lexical: { alpha: 0.30, sem_boost_threshold: 0.65, lex_boost_threshold: 0.80 },
  balanced: { alpha: 0.50, sem_boost_threshold: 0.70, lex_boost_threshold: 0.75 },
  semantic: { alpha: 0.75, sem_boost_threshold: 0.80, lex_boost_threshold: 0.65 },
};

// 편향 라벨에 맞는 하이브리드 검색 파라미터를 반환
export const getPreset = (bias?: RetrievalBias | null): RetrievalPreset => {
  if (!bias) return RETRIEVAL_BIAS_PRESETS.balanced;
  return RETRIEVAL_BIAS_PRESETS[bias] || RETRIEVAL_BIAS_PRESETS.balanced;
};
