export type ChunkHit = {
  postId: string;
  postTitle: string;
  postChunk: string;
  similarityScore: number;
  chunkIndex?: number;
  postCreatedAt?: string;
};

export type PostHit = {
  postId: string;
  postTitle: string;
  score: number;
  createdAt?: string;
  best: { chunkIndex?: number; snippet: string; score: number };
};

export const aggregatePosts = (
  chunks: ChunkHit[],
  opts?: { perPostMax?: number; limit?: number; offset?: number }
): { posts: PostHit[]; total: number } => {
  const perPostMax = Math.max(1, Math.min(5, opts?.perPostMax ?? 2));
  const limit = Math.max(1, Math.min(10, opts?.limit ?? 10));
  const offset = Math.max(0, opts?.offset ?? 0);

  // Group by post
  const byPost = new Map<string, ChunkHit[]>();
  for (const c of chunks) {
    const arr = byPost.get(c.postId) || [];
    arr.push(c);
    byPost.set(c.postId, arr);
  }

  // Build post-level hits
  const posts: PostHit[] = [];
  for (const [postId, arr] of byPost.entries()) {
    const sorted = arr.slice().sort((a, b) => b.similarityScore - a.similarityScore);
    const top = sorted[0];
    const second = sorted[1];
    const score = top.similarityScore + (second ? 0.2 * second.similarityScore : 0);
    posts.push({
      postId,
      postTitle: top.postTitle,
      score,
      createdAt: top.postCreatedAt,
      best: { chunkIndex: top.chunkIndex, snippet: top.postChunk, score: top.similarityScore },
    });
  }

  posts.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  });

  const total = posts.length;
  const page = posts.slice(offset, offset + limit);
  return { posts: page, total };
};

