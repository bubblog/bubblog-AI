import { get_encoding, type TiktokenEncoding } from '@dqbd/tiktoken';

const encodingForModel = (model?: string): TiktokenEncoding => {
  const lower = (model ?? '').toLowerCase();
  if (lower.includes('gpt-5') || lower.includes('gpt-4o') || lower.includes('o1') || lower.includes('o3')) {
    return 'o200k_base' as TiktokenEncoding;
  }
  return 'cl100k_base' as TiktokenEncoding;
};

// 단일 문자열의 토큰 수를 모델별 인코딩으로 계산
export const countTextTokens = (text: string, model: string): number => {
  const encKey = encodingForModel(model);
  const enc = get_encoding(encKey);
  try {
    const tokens = enc.encode(text || '');
    return tokens.length;
  } finally {
    // @dqbd/tiktoken 브라우저 빌드는 명시적 해제가 없어 GC에 맡김
  }
};

type SimpleMessage = { role: string; content: string };

// 메시지 배열의 총 토큰 수를 근사 계산
export const countChatMessagesTokens = (messages: SimpleMessage[], model: string): number => {
  // 근사 계산: 메시지 내용 토큰 수와 최소 오버헤드를 합산
  const overheadPerMsg = 3; // 대략적인 값
  const roleOverhead = 1;
  return messages.reduce((sum, m) => {
    return sum + countTextTokens(m.content || '', model) + overheadPerMsg + roleOverhead;
  }, 0);
};
