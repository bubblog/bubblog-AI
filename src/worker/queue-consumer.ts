import Redis from 'ioredis';
import config from '../config';
import {
  chunkText,
  createEmbeddings,
  storeContentEmbeddings,
  storeTitleEmbedding,
} from '../services/embedding.service';
import { findPostById } from '../repositories/post.repository';
import { deleteEmbeddingsByOwner } from '../repositories/ask-question-cache.repository';

type EmbeddingJob = {
  postId: number;
  title?: boolean | string | null;
  content?: boolean | string | null;
  attempt?: number;
  metadata?: Record<string, unknown>;
};

const queueKey = config.EMBEDDING_QUEUE_KEY;
const failedQueueKey = config.EMBEDDING_FAILED_QUEUE_KEY;
const maxRetries = config.EMBEDDING_WORKER_MAX_RETRIES;
const backoffMs = Math.max(0, config.EMBEDDING_WORKER_BACKOFF_MS || 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const redis =
  config.REDIS_URL && config.REDIS_URL.length > 0
    ? new Redis(config.REDIS_URL)
    : new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
      });

let shuttingDown = false;

const handleShutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn('[embedding-worker]', { type: 'worker.shutdown', signal });
  try {
    redis.disconnect();
  } catch {
    // 무시
  }
  setTimeout(() => process.exit(0), 500).unref();
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// 큐에서 꺼낸 임베딩 작업을 실행
const processJob = async (job: EmbeddingJob) => {
  const postId = Number(job.postId);
  if (!Number.isFinite(postId) || postId <= 0) {
    throw new Error('Invalid postId in embedding job');
  }

  const parseFlag = (value: boolean | string | null | undefined) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lowered = value.trim().toLowerCase();
      if (lowered === 'true') return true;
      if (lowered === 'false') return false;
    }
    return false;
  };

  const shouldProcessTitle = parseFlag(job.title);
  const shouldProcessContent = parseFlag(job.content);

  if (!shouldProcessTitle && !shouldProcessContent) {
    console.warn('[embedding-worker]', {
      type: 'worker.job.skipped',
      postId,
      reason: 'no_targets',
    });
    return;
  }

  const post = await findPostById(postId);

  if (!post) {
    throw new Error(`Post ${postId} not found`);
  }

  const title = typeof post.title === 'string' ? post.title.trim() : '';
  const content = typeof post.content === 'string' ? post.content.trim() : '';

  let invalidateCachedAnswers = false;

  if (shouldProcessTitle) {
    if (!title) {
      console.warn('[embedding-worker]', {
        type: 'worker.job.skipped',
        postId,
        reason: 'empty_title',
      });
    } else {
      await storeTitleEmbedding(postId, title);
      console.log(`[embedding-worker] stored title embedding for post ${postId}`);
      invalidateCachedAnswers = true;
    }
  }

  if (shouldProcessContent) {
    if (!content) {
      console.warn('[embedding-worker]', {
        type: 'worker.job.skipped',
        postId,
        reason: 'empty_content',
      });
      return;
    }

    const chunks = chunkText(content);

    if (!chunks.length) {
      console.warn('[embedding-worker]', {
        type: 'worker.job.skipped',
        postId,
        reason: 'no_chunks',
      });
      return;
    }

    const embeddings = await createEmbeddings(chunks);
    await storeContentEmbeddings(postId, chunks, embeddings);
    console.log(
      `[embedding-worker] stored content embeddings for post ${postId} (chunks=${chunks.length})`
    );
    invalidateCachedAnswers = true;
  }

  if (invalidateCachedAnswers) {
    try {
      const removed = await deleteEmbeddingsByOwner(post.user_id);
      console.log('[embedding-worker]', {
        type: 'worker.ask_cache.invalidate',
        ownerUserId: post.user_id,
        removed,
      });
    } catch (error) {
      console.error('[embedding-worker]', {
        type: 'worker.ask_cache.invalidate_failed',
        ownerUserId: post.user_id,
        message: (error as Error)?.message ?? 'unknown',
      });
    }
  }
};

// 반복 실패한 작업을 실패 큐에 적재
const pushToFailedQueue = async (payload: unknown) => {
  try {
    await redis.lpush(
      failedQueueKey,
      JSON.stringify({
        failedAt: new Date().toISOString(),
        payload,
      })
    );
  } catch (error) {
    console.error('[embedding-worker]', {
      type: 'worker.failed_queue_error',
      message: (error as Error)?.message ?? 'unknown',
    });
  }
};

// Redis에서 수신한 페이로드를 파싱하고 처리
const handlePayload = async (rawPayload: string) => {
  let job: EmbeddingJob;
  try {
    job = JSON.parse(rawPayload) as EmbeddingJob;
  } catch (error) {
    console.error('[embedding-worker]', {
      type: 'worker.job.invalid_json',
      error: (error as Error)?.message ?? 'invalid_json',
    });
    await pushToFailedQueue({ rawPayload, reason: 'invalid_json' });
    return;
  }

  const attempt = Number(job.attempt || 0);
  console.log('[embedding-worker]', {
    type: 'worker.job.start',
    postId: job.postId,
    attempt,
  });

  try {
    await processJob(job);
    console.log('[embedding-worker]', {
      type: 'worker.job.success',
      postId: job.postId,
    });
  } catch (error) {
    const errorMessage = (error as Error)?.message ?? 'unknown';
    const nextAttempt = attempt + 1;
    const enrichedPayload = {
      ...job,
      attempt: nextAttempt,
      lastError: errorMessage,
      failedAt: new Date().toISOString(),
    };

    if (nextAttempt < maxRetries) {
      console.warn('[embedding-worker]', {
        type: 'worker.job.retry',
        postId: job.postId,
        attempt: nextAttempt,
        error: errorMessage,
      });
      if (backoffMs > 0) {
        await sleep(Math.min(backoffMs * nextAttempt, backoffMs * 6));
      }
      await redis.lpush(queueKey, JSON.stringify(enrichedPayload));
    } else {
      console.error('[embedding-worker]', {
        type: 'worker.job.failed',
        postId: job.postId,
        attempt: nextAttempt,
        error: errorMessage,
      });
      await pushToFailedQueue(enrichedPayload);
    }
  }
};

// 워커 메인 루프: BRPOP으로 작업을 소비
const run = async () => {
  console.info('[embedding-worker]', {
    type: 'worker.start',
    queueKey,
    failedQueueKey,
    maxRetries,
  });

  while (!shuttingDown) {
    try {
      const result = await redis.brpop(queueKey, 0);
      if (!result || result.length < 2) continue;
      const payload = result[1];
      await handlePayload(payload);
    } catch (error) {
      if (shuttingDown) break;
      console.error('[embedding-worker]', {
        type: 'worker.loop_error',
        message: (error as Error)?.message ?? 'unknown',
      });
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  }

  console.info('[embedding-worker]', { type: 'worker.exit' });
};

run().catch((error) => {
  console.error('[embedding-worker] fatal error:', error);
  process.exit(1);
});
