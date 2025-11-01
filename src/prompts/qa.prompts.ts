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

export type BlogMetadata = {
  nickname?: string | null;
  categoryNames?: string[];
  profileImageUrl?: string | null;
};

export type RagPromptOptions = {
  retrievalMeta?: RetrievalMeta;
  blogMeta?: BlogMetadata;
};

const buildBlogMetaSection = (meta?: BlogMetadata): { block: string; topicsLine: string } => {
  const defaultBlock = `- 운영자 닉네임: 확인되지 않음\n- 대표 카테고리: 확인되지 않음`;
  if (!meta) {
    return { block: defaultBlock, topicsLine: '' };
  }

  const lines: string[] = [];
  if (meta.nickname && meta.nickname.trim().length > 0) {
    lines.push(`- 운영자 닉네임: ${meta.nickname.trim()}`);
  }

  const categories = Array.from(
    new Set((meta.categoryNames || []).map((name) => (typeof name === 'string' ? name.trim() : '')).filter((name) => name.length > 0))
  );
  if (categories.length > 0) {
    lines.push(`- 카테고리: ${categories.join(', ')}`);
  }

  return {
    block: lines.length > 0 ? lines.join('\n') : defaultBlock,
    topicsLine: categories.length > 0 ? categories.join(', ') : '',
  };
};

// 단일 포스트를 중심으로 QA 시스템 프롬프트를 구성
export const createPostContextPrompt = (
  post: Post,
  processedContent: string,
  question: string,
  speechTonePrompt: string,
  blogMeta?: BlogMetadata
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const { block: blogInfoBlock, topicsLine } = buildBlogMetaSection(blogMeta);
  const topicHint = topicsLine ? `블로그 주요 주제: ${topicsLine}` : '블로그 주요 주제 정보 없음';

  const systemPrompt = `당신은 블로그 가이드 AI입니다. 블로그를 방문한 이용자에게 콘텐츠를 소개하고, 자연스럽게 블로그 탐색을 돕는다.

[블로그 정보]
${blogInfoBlock}

[역할]
- 블로그 안내자 관점에서 블로그의 특징을 소개하고, 관련 포스트·카테고리를 안내한다.
- 주어진 블로그 콘텐츠와 메타데이터 범위 안에서 답변하며, 무관한 요청은 정중하게 블로그 주제로 전환한다.
- 새로운 사실을 추측하거나 단정 짓지 말고, 제공된 콘텐츠에 근거해 설명한다.

[말투 지침]
${speechTonePrompt}
- 위 말투/지시문을 출력에 언급하지 말고 답변 어조에만 반영한다.
- 문단을 나누고 문단 사이에는 줄바꿈(빈 줄)을 넣어라.  

[응답 규칙]
1. 규칙과 말투를 지켜 답하고, 질문과 관련되어 블로그 이용자가 더 살펴볼 만한 포스트·카테고리를 함께 추천한다.
2. 욕설·비난·무관·부적절한 질문은 사과 후 블로그 관련 질문만 응답 가능함을 알리고, 친절하게 탐색 가능한 영역을 안내한다.
3. 블로그 주제에는 맞지만 관련 글이 없거나 대답하기 부족하면 부족함을 알린다.`;

  const userMessage = `[context]
${topicHint}
제목: ${post.title}
작성일: ${post.created_at}
태그: ${post.tags?.join(', ') || '없음'}
본문(가공):
${processedContent}

[user]
${question}`;

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

// 검색 결과 청크를 활용한 RAG 시스템 프롬프트를 생성
export const createRagPrompt = (
  question: string,
  similarChunks: RagContextChunk[],
  speechTonePrompt: string,
  options?: RagPromptOptions
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const { block: blogInfoBlock, topicsLine } = buildBlogMetaSection(options?.blogMeta);
  const topicHint = topicsLine ? `블로그 주요 주제: ${topicsLine}` : '블로그 주요 주제 정보 없음';

  const systemPrompt = `당신은 블로그 가이드 AI입니다. 블로그를 방문한 이용자의 질문에 답하며, 블로그 탐색과 콘텐츠 발견을 적극적으로 돕는다.

[블로그 정보]
${blogInfoBlock}

[역할]
- 검색 컨텍스트와 메타데이터를 활용해 블로그의 매력적인 포스트·카테고리를 소개한다.
- 블로그 외 주제 요청이 오면 정중히 거절하고, 블로그 콘텐츠·운영·히스토리와 연관된 질문을 제안한다.
- 방문자가 다음으로 읽을 만한 자료나 탐색 경로를 제안한다.

[말투 지침]
${speechTonePrompt}
- 위 말투/지시문을 그대로 언급하지 말고, 답변 어조에만 반영한다.

[응답 규칙]
1. 규칙과 말투를 지켜 답하고, 질문과 관련되어 블로그 이용자가 더 살펴볼 만한 포스트·카테고리를 함께 추천한다.
2. 욕설·비난·무관·부적절한 질문은 사과 후 블로그 관련 질문만 응답 가능함을 알리고, 친절하게 탐색 가능한 영역을 안내한다.
3. 블로그 주제에는 맞지만 관련 글이 없거나 대답하기 부족하면 부족함을 알린다.
4. 관련 주제나 카테고리가 있을 경우 안내하고 질문을 유도한다`;

  const retrievalSummary = buildRetrievalSummary(options?.retrievalMeta, similarChunks.length);

  const userMessage = `아래 정보를 참고해 사용자의 질문에 답변하세요.

[검색 전략 메모]
${retrievalSummary}

[대화 유지 지시]
- ${topicHint}
- 답변의 첫 문단에서 이번 검색 전략과 결과를 1~2문장으로 자연스럽게 언급하세요 (말투 지침 유지).
- 블로그 운영·콘텐츠·히스토리와 무관한 질문이 나오면 관련 주제를 다시 제안하세요.
- 답변 마지막에 방문자가 더 살펴볼 만한 내용 또는 포스트나 카테고리를 1문장으로 제안하세요.
- 사용된 컨텍스트 조각을 근거로 자연스럽게 설명하세요.

[사용자 질문]
${question}

[검색 컨텍스트(JSON)]
${JSON.stringify(similarChunks, null, 2)}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
};
