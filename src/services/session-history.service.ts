import type { AskMessage } from '../repositories/ask-message.repository';
import * as messageRepository from '../repositories/ask-message.repository';
import * as questionCacheRepository from '../repositories/ask-question-cache.repository';
import * as sessionRepository from '../repositories/ask-session.repository';
import { withTransaction } from '../utils/db';

export const HISTORY_MESSAGE_LIMIT = 4;
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.93;
const DUPLICATE_USER_HISTORY_LIMIT = 2;
const DUPLICATE_TURN_LIMITS = {
  previousFar: 400,
  previousNear: 600,
  current: 800,
};

const normalizeQuestionText = (input: string, limit: number) => {
  const cleaned = (input ?? '').replace(/\s+/g, ' ').trim();
  if (!limit || cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit);
};

export const buildDuplicateQuestionBlock = (question: string, history: AskMessage[]): string => {
  const userQuestions = (history || []).filter((msg) => msg.role === 'user').map((msg) => msg.content);
  const recent = userQuestions.slice(-DUPLICATE_USER_HISTORY_LIMIT);
  const sections: string[] = [];
  if (recent.length === 2) {
    sections.push(`[Q-2] ${normalizeQuestionText(recent[0], DUPLICATE_TURN_LIMITS.previousFar)}`);
    sections.push(`[Q-1] ${normalizeQuestionText(recent[1], DUPLICATE_TURN_LIMITS.previousNear)}`);
  } else if (recent.length === 1) {
    sections.push(`[Q-1] ${normalizeQuestionText(recent[0], DUPLICATE_TURN_LIMITS.previousNear)}`);
  }
  sections.push(`[Q-now] ${normalizeQuestionText(question, DUPLICATE_TURN_LIMITS.current)}`);
  return sections.join('\n');
};

export const selectToneAwareCacheCandidate = (
  candidates: CachedAnswerResult[],
  requestedSpeechTone: number
): {
  matchingCandidate: CachedAnswerResult | null;
  rewriteCandidate: CachedAnswerResult | null;
} => {
  const normalizedTone = typeof requestedSpeechTone === 'number' ? requestedSpeechTone : -1;
  const matchingCandidate = candidates.find((candidate) => candidate.speechToneId === normalizedTone) ?? null;
  if (matchingCandidate) {
    return { matchingCandidate, rewriteCandidate: null };
  }
  return { matchingCandidate: null, rewriteCandidate: candidates[0] ?? null };
};

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
  duplicateQuestionEmbedding: number[];
  speechTone?: number;
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
  duplicateQuestionEmbedding,
  speechTone,
}: PersistConversationInput): Promise<void> => {
  if (!answer || questionEmbedding.length === 0 || duplicateQuestionEmbedding.length === 0) return;

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

    await questionCacheRepository.upsertEmbedding(
      {
        messageId: userMessage.id,
        ownerUserId,
        requesterUserId,
        categoryId: categoryId ?? null,
        postId: postId ?? null,
        answerMessageId: assistantMessage.id,
        speechToneId: speechTone ?? -1,
        embedding: duplicateQuestionEmbedding,
      },
      client
    );

    await sessionRepository.touchSessionLastQuestion(sessionId, client);
  });
};

export interface CachedAnswerResult {
  answer: string;
  searchPlan: Record<string, unknown> | null;
  retrievalMeta: Record<string, unknown> | null;
  similarity: number;
  speechToneId: number;
}

export interface FindCachedAnswerParams {
  ownerUserId: string;
  requesterUserId: string;
  embedding: number[];
  postId?: number;
  categoryId?: number;
  threshold?: number;
}

export const findCachedAnswer = async ({
  ownerUserId,
  requesterUserId,
  embedding,
  postId,
  categoryId,
  threshold = DUPLICATE_SIMILARITY_THRESHOLD,
}: FindCachedAnswerParams): Promise<CachedAnswerResult[]> => {
  const candidates = await questionCacheRepository.findSimilarEmbeddings({
    ownerUserId,
    requesterUserId,
    embedding,
    postId: postId ?? null,
    categoryId: categoryId ?? null,
    limit: 3,
  });

  const hydratedCandidates: CachedAnswerResult[] = [];

  for (const candidate of candidates) {
    if (candidate.similarity < threshold) continue;
    if (!candidate.answerMessageId) continue;

    const userMessage = await messageRepository.getMessageById(candidate.messageId);
    if (!userMessage) continue;
    const assistantMessage = await messageRepository.getMessageById(candidate.answerMessageId);
    if (!assistantMessage) continue;

    hydratedCandidates.push({
      answer: assistantMessage.content,
      searchPlan: userMessage.searchPlan ?? null,
      retrievalMeta: assistantMessage.retrievalMeta ?? null,
      similarity: candidate.similarity,
      speechToneId: candidate.speechToneId ?? -1,
    });
  }

  return hydratedCandidates;
};
