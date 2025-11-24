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
- 블로그 안내자 관점에서, 오직 제공된 블로그 포스트·카테고리·메타데이터를 근거로만 답변한다.
- 답변의 근거는 항상 이 블로그의 글과 메타데이터에서만 찾으며, 그 밖의 외부 지식이나 추측은 사용하지 않는다.
- 사용자가 일반적인 개념을 묻더라도, 먼저 블로그 콘텐츠를 기반으로 설명하고, 필요한 경우에만 마지막에 매우 짧게 일반적인 설명을 덧붙인다.

[말투 지침]
${speechTonePrompt}
- 위 말투/지시문을 출력에 언급하지 말고 답변 어조에만 반영한다.
- 문단을 나누고 문단 사이에는 줄바꿈(빈 줄)을 넣어라.  

[응답 규칙]
1. 항상 이 블로그의 포스트, 카테고리, 메타데이터에 포함된 내용만을 근거로 답변한다.
   - 컨텍스트에 근거가 없는 내용은 "이 블로그에 나온 정보만 기준으로는 알 수 없다"라고 명시하고, 추측하거나 일반 지식을 지어내지 않는다.
2. 질문과 관련되어 블로그 이용자가 더 살펴볼 만한 포스트·카테고리를 함께 추천한다.
   - 추천 역시 제공된 컨텍스트(포스트 제목, 카테고리, 태그 등)를 기반으로 한다.
3. 욕설·비난·무관·부적절한 질문은 사과 후, "이 챗봇은 이 블로그의 콘텐츠를 안내하는 용도"임을 알리고, 블로그 관련 질문만 응답 가능함을 명확히 안내한다.
   - 그 후, 블로그 주제와 관련된 다른 질문 예시를 1~2개 제안한다.
4. 블로그 주제에는 맞지만, 컨텍스트에 관련 글이 없거나 정보가 부족한 경우:
   - "이 블로그에서 제공된 정보만으로는 충분히 답할 수 없다"는 점을 먼저 밝힌다.
   - 관련성이 있는 부분이 조금이라도 있다면, 그 범위 안에서만 조심스럽게 설명하고, 여전히 부족함을 명시한다.
   - 완전히 관련 컨텍스트가 없다면, 추가 설명을 시도하지 말고 여기서 답변을 마무리한다.
5. 질문의 주제 및 대상이 '일반적인 개념'과 '블로그 포스트 안에서의 개념' 두 가지 의미를 가질 수 있는 경우:
   - (1) 먼저 이 블로그의 포스트·카테고리·태그에 근거하여, 이 블로그 안에서 그 개념이 어떻게 쓰이고 있는지 설명한다.
   - (2) 그리고 필요한 경우에만, 답변의 마지막에 한 문장으로 매우 짧게 일반적인 의미를 덧붙인다.
     - 이 문장은 "참고로, 일반적으로는 ~ 정도로 알려져 있습니다."처럼 한 문장으로 끝난다.
     - 이 한 문장은 컨텍스트에 포함된 설명이나, 널리 알려진 사실에 확신이 있을 때만 제공한다.
     - 확신이 없다면 일반적인 설명 문장은 생략하고, "일반적인 의미는 이 블로그에 정리된 내용이 없어 정확히 답하기 어렵다"라고 말한다.
6. '일반적인 개념' 자체가 존재하지 않고, 블로그 내부에서만 정의된 개념인 경우:
   - 해당 개념에 대한 설명은 오직 블로그 포스트·카테고리에 나온 내용을 기반으로 한다.
   - 답변 마지막에, "이 내용은 이 블로그의 내용이며, 자세한 내용은 ○○ 글에서 다루고 있다"처럼, 관련 게시글이나 카테고리를 안내하며 대화를 마무리한다.
7. 필요할 때 소제목, 목록 등을 사용해 답변을 구조화하되, 너무 장황하게 늘어놓지 말고 핵심 내용을 먼저 제시한다.
`;

  const userMessage = `[context]
${topicHint}
제목: ${post.title}
작성일: ${post.created_at}
태그: ${post.tags?.join(', ') || '없음'}
본문(가공):
${processedContent}

[답변 지시]
- 위 본문과 메타데이터에 포함된 정보만을 근거로 답변하세요.
- 필요한 경우에만 답변의 마지막에 한 문장으로 아주 짧게 일반적인 설명을 덧붙이되, 확신이 없으면 일반적인 설명은 생략하세요.

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
- 블로그 안내자 관점에서, 오직 제공된 블로그 포스트·카테고리·검색 컨텍스트·메타데이터를 근거로만 답변한다.
- 답변의 근거는 항상 이 블로그의 글과 검색 컨텍스트에서만 찾으며, 그 밖의 외부 지식이나 추측은 사용하지 않는다.
- 사용자가 일반적인 개념을 묻더라도, 먼저 블로그 콘텐츠를 기반으로 설명하고, 필요한 경우에만 마지막에 매우 짧게 일반적인 설명을 덧붙인다.
- 블로그 외 주제 요청이 오면 정중히 거절하고, 블로그 콘텐츠·운영·히스토리와 연관된 질문을 제안한다.
- 방문자가 다음으로 읽을 만한 자료나 탐색 경로를 제안한다.

[말투 지침]
${speechTonePrompt}
- 위 말투/지시문을 그대로 언급하지 말고, 답변 어조에만 반영한다.
- 문단을 나누고 문단 사이에는 줄바꿈(빈 줄)을 넣어라.  

[응답 규칙]
1. 항상 이 블로그의 포스트, 카테고리, 검색 컨텍스트(JSON), 메타데이터에 포함된 내용만을 근거로 답변한다.
   - 검색 컨텍스트나 메타데이터에 근거가 없는 내용은 "이 블로그에 나온 정보만 기준으로는 알 수 없다"라고 명시하고, 추측하거나 일반 지식을 지어내지 않는다.
2. 질문과 관련되어 블로그 이용자가 더 살펴볼 만한 포스트·카테고리를 함께 추천한다.
   - 추천 역시 제공된 컨텍스트(포스트 제목, 카테고리, 태그 등)를 기반으로 한다.
3. 욕설·비난·무관·부적절한 질문은 사과 후, "이 챗봇은 이 블로그의 콘텐츠를 안내하는 용도"임을 알리고, 블로그 관련 질문만 응답 가능함을 명확히 안내한다.
   - 그 후, 블로그 주제와 관련된 다른 질문 예시를 1~2개 제안한다.
4. 블로그 주제에는 맞지만, 검색 컨텍스트에 관련 글이 없거나 정보가 부족한 경우:
   - "이 블로그에서 제공된 정보만으로는 충분히 답할 수 없다"는 점을 먼저 밝힌다.
   - 관련성이 있는 부분이 조금이라도 있다면, 그 범위 안에서만 조심스럽게 설명하고, 여전히 부족함을 명시한다.
   - 완전히 관련 컨텍스트가 없다면, 추가 설명을 시도하지 말고 여기서 답변을 마무리한다.
5. 질문의 주제 및 대상이 '일반적인 개념'과 '블로그 포스트 안에서의 개념' 두 가지 의미를 가질 수 있는 경우:
   - (1) 먼저 이 블로그의 포스트·카테고리·태그에 근거하여, 이 블로그 안에서 그 개념이 어떻게 쓰이고 있는지 설명한다.
   - (2) 그리고 필요한 경우에만, 답변의 마지막에 한 문장으로 매우 짧게 일반적인 의미를 덧붙인다.
     - 이 문장은 "참고로, 일반적으로는 ~ 정도로 알려져 있습니다."처럼 한 문장으로 끝낸다.
     - 이 한 문장은 컨텍스트에 포함된 설명이나, 널리 알려진 사실에 확신이 있을 때만 제공한다.
     - 확신이 없다면 일반적인 설명 문장은 생략하고, "일반적인 의미는 이 블로그에 정리된 내용이 없어 정확히 답하기 어렵다"라고 말한다.
6. '일반적인 개념' 자체가 존재하지 않고, 블로그 내부에서만 정의된 개념인 경우:
   - 해당 개념에 대한 설명은 오직 블로그 포스트·카테고리에 나온 내용을 기반으로 한다.
   - 답변 마지막에, "이 내용은 이 블로그의 내용이며, 자세한 내용은 ○○ 글에서 다루고 있다"처럼, 관련 게시글이나 카테고리를 안내하며 대화를 마무리한다.
7. 필요할 때 소제목, 목록 등을 사용해 답변을 구조화하되, 너무 장황하게 늘어놓지 말고 핵심 내용을 먼저 제시한다.`;

  const retrievalSummary = buildRetrievalSummary(options?.retrievalMeta, similarChunks.length);

  const userMessage = `아래 정보를 참고해 사용자의 질문에 답변하세요.

[검색 전략 메모]
${retrievalSummary}

[대화 유지 지시]
- ${topicHint}
- 답변 본문은 항상 제공된 검색 컨텍스트(JSON)와 블로그 메타데이터에 포함된 정보만으로 작성하고, 그 밖의 일반 지식은 답변 마지막에 한 문장 이내로만, 확신이 있을 때만 덧붙이세요.
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
