import { Post, SimilarChunk } from '../repositories/post.repository';
import OpenAI from 'openai';

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
  3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면, 함수명이나 함수 호출을 절대 언급하지 말고(예: "report_content_insufficient" 같은 문자열이나 괄호 "()" 출력 금지), 답변 말투 및 규칙을 지켜 자연스럽게 다음을 수행합니다: (a) 현재로서는 본문 컨텍스트가 부족함을 간단히 안내하고, (b) 질문과 직접 관련된 정보를 구체적으로 요청합니다(예: 게시일, 최근 글 목록, 최신 포스트의 제목과 날짜 등). 서버가 내부 함수를 제공하는 경우에도 사용자가 보는 답변에는 함수명/호출을 절대 노출하지 않습니다. 
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

export const createRagPrompt = (
  question: string,
  similarChunks: SimilarChunk[],
  speechTonePrompt: string
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
  3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면, 함수명이나 함수 호출을 절대 언급하지 말고(예: "report_content_insufficient" 같은 문자열이나 괄호 "()" 출력 금지), 답변 말투 및 규칙을 지켜 자연스럽게 다음을 수행합니다: (a) 현재로서는 본문 컨텍스트가 부족함을 간단히 안내하고, (b) 질문과 직접 관련된 정보를 구체적으로 요청합니다(예: 게시일, 최근 글 목록, 최신 포스트의 제목과 날짜 등). 서버가 내부 함수를 제공하는 경우에도 사용자가 보는 답변에는 함수명/호출을 절대 노출하지 않습니다. 
  `;
  const userMessage = `
    아래의 질문과 블로그 본문 컨텍스트를 참고하여 답변하세요.
    사용자의 질문: ${question}
    가장 근접한 블로그 본문 컨텍스트:
    ${JSON.stringify(similarChunks, null, 2)}
  `;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
};
