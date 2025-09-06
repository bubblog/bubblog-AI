import { Post, SimilarChunk } from '../repositories/post.repository';
import OpenAI from 'openai';

export const createPostContextPrompt = (
  post: Post,
  processedContent: string,
  question: string,
  speechTonePrompt: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const systemPrompt = `너는 사용자의 블로그 글 컨텍스트만으로 답변한다. 컨텍스트에 없는 사실은 추정하지 말고 “문서에 없음”이라고 말한다. 말투는 speech_tone 지시에 따른다.`;
  const userMessage = `
[context]
제목: ${post.title}
작성일: ${post.created_at}
태그: ${post.tags?.join(', ') || '없음'}
본문(가공):
${processedContent}

[user]
${question}

[instruction]
답변 말투: "${speechTonePrompt}"
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
  
  [응답 규칙]
  1. 만약 제목과 본문을 활용해 답변할 수 있다면 답변 말투 및 규칙을 지켜 직접 답변하고, 마지막에 추가적인 내용에 대한 질문을 유도하는 문장을 추가합니다.
  2. 만약 질문이 욕설·비난·무관·부적절하거나 주어진 제목, 본문과 관련이 없다면 사과와 블로그 관련된 내용만 답변 가능하다는 내용을 답변 말투 및 규칙을 지켜 답합니다.  
  3. 질문이 블로그 카테고리나 사용자 블로그에는 부합하지만 제공된 본문 컨텍스트의 내용이 매우 부족하거나 적절하지 않다고 판단되면 report_content_insufficient 함수를 호출하고 답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다. 
  `;
  const userMessage = `
    답변 말투 및 규칙: "${speechTonePrompt}"
    반드시 말투 및 규칙에 따라 대답하세요!
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
