import * as messageRepository from '../repositories/ask-message.repository';
import * as embeddingRepository from '../repositories/ask-message-embedding.repository';
import * as sessionRepository from '../repositories/ask-session.repository';
import { withTransaction } from '../utils/db';

export const HISTORY_MESSAGE_LIMIT = 4;

export const loadRecentMessages = async (sessionId: number, limit = HISTORY_MESSAGE_LIMIT) => {
  const boundedLimit = Math.max(0, Math.min(limit, HISTORY_MESSAGE_LIMIT));
  if (boundedLimit === 0) return [];
  return messageRepository.getLatestMessages(sessionId, boundedLimit);
};

export interface PersistConversationInput {
  sessionId: number;
  requesterUserId: string;
  ownerUserId: string;
  question: string;
  answer: string;
  searchPlan?: Record<string, unknown> | null;
  retrievalMeta?: Record<string, unknown> | null;
  categoryId?: number;
  postId?: number;
  questionEmbedding: number[];
}

export const persistConversation = async ({
  sessionId,
  requesterUserId,
  ownerUserId,
  question,
  answer,
  searchPlan,
  retrievalMeta,
  categoryId,
  postId,
  questionEmbedding,
}: PersistConversationInput): Promise<void> => {
  if (!answer || questionEmbedding.length === 0) return;

  await withTransaction(async (client) => {
    const userMessage = await messageRepository.insertMessage(
      {
        sessionId,
        role: 'user',
        content: question,
        searchPlan: searchPlan ?? null,
        retrievalMeta: null,
      },
      client
    );

    const assistantMessage = await messageRepository.insertMessage(
      {
        sessionId,
        role: 'assistant',
        content: answer,
        searchPlan: null,
        retrievalMeta: retrievalMeta ?? null,
      },
      client
    );

    await embeddingRepository.upsertEmbedding(
      {
        messageId: userMessage.id,
        ownerUserId,
        requesterUserId,
        categoryId: categoryId ?? null,
        postId: postId ?? null,
        answerMessageId: assistantMessage.id,
        embedding: questionEmbedding,
      },
      client
    );

    await sessionRepository.touchSessionLastQuestion(sessionId, client);
  });
};
