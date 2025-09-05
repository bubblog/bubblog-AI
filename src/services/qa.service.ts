import pgvector from 'pgvector/pg';
import { getDb } from '../utils/db';
import { createEmbeddings } from './embedding.service';
import OpenAI from 'openai';
import config from '../config';
import { PassThrough } from 'stream';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

interface SimilarChunk {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
}

export const findSimilarChunks = async (
  question: string,
  userId: string,
  categoryId?: number
): Promise<SimilarChunk[]> => {
  const [questionEmbedding] = await createEmbeddings([question]);
  const pool = getDb();

  const params: any[] = [userId, pgvector.toSql(questionEmbedding)];
  let sql: string;

  if (categoryId) {
    sql = `
      WITH category_ids AS (
        SELECT DISTINCT cc.descendant_id
        FROM category_closure cc
        WHERE cc.ancestor_id = $3
      ),
      filtered_posts AS (
        SELECT bp.id AS post_id, bp.title AS post_title
        FROM blog_post bp
        WHERE bp.user_id = $1 AND bp.category_id IN (SELECT descendant_id FROM category_ids)
      )
      SELECT
        fp.post_id,
        fp.post_title,
        pc.content AS post_chunk,
        (0.7 * (1.0 - (pc.embedding <=> $2))) + (0.3 * (1.0 - (pte.embedding <=> $2))) AS similarity_score
      FROM filtered_posts fp
      JOIN post_chunks pc ON pc.post_id = fp.post_id
      JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
      WHERE (1.0 - (pc.embedding <=> $2)) > 0.2
      ORDER BY similarity_score DESC
      LIMIT 5;
    `;
    params.push(categoryId);
  } else {
    sql = `
      WITH filtered_posts AS (
        SELECT id AS post_id, title AS post_title
        FROM blog_post
        WHERE user_id = $1
      )
      SELECT
        fp.post_id,
        fp.post_title,
        pc.content AS post_chunk,
        (0.7 * (1.0 - (pc.embedding <=> $2))) + (0.3 * (1.0 - (pte.embedding <=> $2))) AS similarity_score
      FROM filtered_posts fp
      JOIN post_chunks pc ON pc.post_id = fp.post_id
      JOIN post_title_embeddings pte ON pte.post_id = fp.post_id
      WHERE (1.0 - (pc.embedding <=> $2)) > 0.2
      ORDER BY similarity_score DESC
      LIMIT 5;
    `;
  }

  const { rows } = await pool.query(sql, params);

  return rows.map((row) => ({
    postId: row.post_id,
    postTitle: row.post_title,
    postChunk: row.post_chunk,
    similarityScore: row.similarity_score,
  }));
};

const getSpeechTonePrompt = async (speechTone: number, userId: string): Promise<string> => {
  if (speechTone === -1) return "간결하고 명확한 말투로 답변해";
  if (speechTone === -2) return "아래의 블로그 본문 컨텍스트를 참고하여 본문의 말투를 파악해 최대한 비슷한 말투로 답변해";

  const pool = getDb();
  const { rows } = await pool.query(
    'SELECT name, description FROM persona WHERE id = $1 AND user_id = $2',
    [speechTone, userId]
  );

  if (rows.length > 0) {
    return `${rows[0].name}: ${rows[0].description}`;
  }
  return "간결하고 명확한 말투로 답변해"; // Default
}

export const answerStream = async (
  question: string,
  userId: string,
  categoryId?: number,
  speechTone: number = -1
): Promise<PassThrough> => {
  const stream = new PassThrough();
  const similarChunks = await findSimilarChunks(question, userId, categoryId);

  const existInPost = similarChunks.length > 0;
  stream.write(`event: exist_in_post_status\ndata: ${JSON.stringify(existInPost)}\n\n`);

  const context = similarChunks.map(chunk => ({ postId: chunk.postId, postTitle: chunk.postTitle }));
  stream.write(`event: context\ndata: ${JSON.stringify(context)}\n\n`);

  const speechTonePrompt = await getSpeechTonePrompt(speechTone, userId);

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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "report_content_insufficient",
          description: "카테고리는 맞지만 본문 컨텍스트가 부족할 때 호출",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "답변 말투 및 규칙을 지켜 해당 내용이 아직 부족하다는 안내를 합니다. 그 후 본문 컨텍스트를 참고해 질문과 관련된 답변할 수 있는 내용을 언급하고 해당 내용에 대한 질문을 직접적으로 유도합니다." },
            },
            required: ["text"],
          },
        },
      },
  ];

  openai.chat.completions.create({
    model: config.CHAT_MODEL,
    messages,
    tools,
    tool_choice: 'auto',
    stream: true,
  }).then(async (responseStream) => {
    for await (const chunk of responseStream) {
      const content = chunk.choices[0]?.delta?.content || "";
      const toolCalls = chunk.choices[0]?.delta?.tool_calls;

      if (toolCalls) {
        for (const toolCall of toolCalls) {
          if (toolCall.function?.arguments) {
            // JSON.stringify를 제거하여 원시 문자열을 보냅니다.
            stream.write(`event: answer\ndata: '${toolCall.function.arguments}'\n\n`);
          }
        }
      } else if (content) {
        // JSON.stringify를 제거하여 원시 문자열을 보냅니다.
        stream.write(`event: answer\ndata: '${content}'\n\n`);
      }

      if (chunk.choices[0]?.finish_reason) {
        stream.write(`event: end\ndata: [DONE]\n\n`);
        stream.end();
        break;
      }
    }
  }).catch(err => {
      console.error('OpenAI stream error:', err);
      stream.write(`event: error\ndata: ${JSON.stringify({message: 'Internal AI error'})}\n\n`);
      stream.end();
  });

  return stream;
};
