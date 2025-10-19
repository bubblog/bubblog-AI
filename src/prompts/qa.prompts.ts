import { Post } from '../repositories/post.repository';
import OpenAI from 'openai';
import { SearchPlan } from '../types/ai.v2.types';

export type RagContextChunk = {
  postId: string;
  postTitle: string;
  postChunk: string;
  createdAt?: string | null;
};

type RetrievalMeta = {
  strategy: string;
  plan?: Partial<SearchPlan>;
  resultCount?: number;
  notes?: string[];
};

export type RagPromptOptions = {
  retrievalMeta?: RetrievalMeta;
};

export const createPostContextPrompt = (
  post: Post,
  processedContent: string,
  question: string,
  speechTonePrompt: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const systemPrompt = ` 당신은 블로그 운영자 AI입니다. 사용자의 블로그에 대한 질문에 답변합니다. 
  블로그 운영자 AI는 사용자의 질문에 대해 블로그 본문 컨텍스트를 참고하여 답변합니다.
  모든 한국어 응답은 무슨일이 있어도 반드시 답변 말투 및 규칙을 따릅니다. 
  또한 주어진 내용외의 내용을 지어내지 마십시오.
  
  [말투 지침]
  ${speechTonePrompt}
  - 위 말투/지시문을 출력에 절대 노출하지 말고(예: "말투", "규칙" 등 언급 금지), 실제 답변 내용에만 반영하십시오.
  
  [응답 규칙]
  1. 만약 제목과 본문을 활용해 답변할 수 있다면 답변 말투 및 규칙을 지켜 직접 답변하고, 마지막에 추가적인 내용에 대한 질문을 유도하는 문장을 추가합니다.
  2. 만약 질문이 욕설·비난·무관·부적절하거나 주어진 제목, 본문과 관련이 없다면 사과와 블로그 관련된 내용만 답변 가능하다는 내용을 답변 말투 및 규칙을 지켜 답합니다.  
  3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면, 답변 말투 및 규칙을 지켜 자연스럽게 다음을 수행합니다: (a) 현재로서는 본문 컨텍스트가 부족함을 간단히 안내하고, (b) 질문과 직접 관련된 정보를 구체적으로 요청합니다(예: 게시일, 최근 글 목록, 최신 포스트의 제목과 날짜 등). 
  `;
  const userMessage = `
[context]
제목: ${post.title}
작성일: ${post.created_at}
태그: ${post.tags?.join(', ') || '없음'}
본문(가공):
${processedContent}

[user]
${question}
`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
};

const describeTimeFilter = (plan?: Partial<SearchPlan>): string | null => {
  const time = plan?.filters?.time;
  if (!time) return null;
  switch (time.type) {
    case 'absolute':
      return `절대 기간 ${time.from} ~ ${time.to}`;
    case 'relative':
      return `최근 ${time.value}${time.unit === 'day' ? '일' : time.unit === 'week' ? '주' : time.unit === 'month' ? '개월' : '년'}`;
    case 'named':
      return `사전 설정 "${time.preset}"`;
    case 'label':
      return `레이블 "${time.label}"`;
    case 'month':
      return `${time.year ?? '올해'}년 ${time.month}월`;
    case 'quarter':
      return `${time.year ?? '올해'}년 ${time.quarter}분기`;
    case 'year':
      return `${time.year}년`;
    default:
      return null;
  }
};

const buildRetrievalSummary = (
  meta: RetrievalMeta | undefined,
  fallbackResultCount: number
): string => {
  if (!meta) {
    return [
      '전략: 기본 임베딩 기반 유사도 검색',
      `검색 결과 수: ${fallbackResultCount}`,
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`전략: ${meta.strategy}`);
  if (meta.plan) {
    const pieces: string[] = [];
    if (typeof meta.plan.top_k === 'number') pieces.push(`top_k=${meta.plan.top_k}`);
    if (typeof meta.plan.limit === 'number') pieces.push(`limit=${meta.plan.limit}`);
    if (typeof meta.plan.threshold === 'number') pieces.push(`threshold=${meta.plan.threshold}`);
    if (meta.plan.hybrid?.enabled) {
      pieces.push(
        `hybrid(${meta.plan.hybrid.retrieval_bias || 'balanced'}, alpha=${meta.plan.hybrid.alpha ?? 'auto'})`
      );
    }
    const timeDesc = describeTimeFilter(meta.plan);
    if (timeDesc) pieces.push(`시간 필터=${timeDesc}`);
    if (pieces.length > 0) {
      lines.push(`주요 파라미터: ${pieces.join(', ')}`);
    }
    if (Array.isArray(meta.plan.rewrites) && meta.plan.rewrites.length > 0) {
      lines.push(`재작성 문장: ${meta.plan.rewrites.join(' | ')}`);
    }
    if (Array.isArray(meta.plan.keywords) && meta.plan.keywords.length > 0) {
      lines.push(`검색 키워드: ${meta.plan.keywords.join(' | ')}`);
    }
  }
  lines.push(`검색 결과 수: ${meta.resultCount ?? fallbackResultCount}`);
  if (meta.notes?.length) {
    lines.push(`비고: ${meta.notes.join(' / ')}`);
  }
  return lines.join('\n');
};

export const createRagPrompt = (
  question: string,
  similarChunks: RagContextChunk[],
  speechTonePrompt: string,
  options?: RagPromptOptions
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const systemPrompt = `
  당신은 블로그 운영자 AI입니다. 사용자의 블로그에 대한 질문에 답변합니다. 
  블로그 운영자 AI는 사용자의 질문에 대해 블로그 본문 컨텍스트를 참고하여 답변합니다.
  모든 한국어 응답은 무슨일이 있어도 반드시 답변 말투 및 규칙을 따릅니다. 
  또한 주어진 내용외의 내용을 지어내지 마십시오.
  
  [말투 지침]
  ${speechTonePrompt}
  - 위 말투/지시문을 출력에 절대 노출하지 말고(예: "말투", "규칙" 등 언급 금지), 실제 답변 내용에만 반영하십시오.
  
  [응답 규칙]
  1. 만약 제목과 본문을 활용해 답변할 수 있다면 답변 말투 및 규칙을 지켜 직접 답변하고, 마지막에 추가적인 내용에 대한 질문을 유도하는 문장을 추가합니다.
  2. 만약 질문이 욕설·비난·무관·부적절하거나 주어진 제목, 본문과 관련이 없다면 사과와 블로그 관련된 내용만 답변 가능하다는 내용을 답변 말투 및 규칙을 지켜 답합니다.  
  3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면 답변 말투 및 규칙을 지켜 자연스럽게 다음을 수행합니다: (a) 현재로서는 본문 컨텍스트가 부족함을 간단히 안내하고, (b) 질문과 직접 관련된 정보를 구체적으로 요청합니다(예: 게시일, 최근 글 목록, 최신 포스트의 제목과 날짜 등). 
  `;

  const retrievalSummary = buildRetrievalSummary(options?.retrievalMeta, similarChunks.length);

  const userMessage = `
    아래의 질문과 블로그 본문 컨텍스트를 참고하여 답변하세요.
    [검색 전략 메모]
    ${retrievalSummary}

    [응답 시 추가 지시]
    - 답변의 첫 문단에서 이번 검색 전략과 그 결과임을 1~2문장으로 자연스럽게 언급하세요. (말투 지침은 유지)

    사용자의 질문: ${question}
    가장 근접한 블로그 본문 컨텍스트:
    ${JSON.stringify(similarChunks, null, 2)}
  `;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
};
