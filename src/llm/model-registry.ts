import { ProviderName } from './types';

type ModelEntry = {
  provider: ProviderName;
  modelId: string;
};

// 현재는 기본 레지스트리만 제공하며 추후 토크나이저나 과금 정보로 확장 가능
const DEFAULT_CHAT: ModelEntry = { provider: 'openai', modelId: 'gpt-5-mini' };

// 프로젝트 기본 채팅 모델 정보를 반환
export const getDefaultChat = (): ModelEntry => DEFAULT_CHAT;
