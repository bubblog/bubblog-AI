import { get_encoding } from '@dqbd/tiktoken';
import config from '../config';
import OpenAI from 'openai';
import * as postRepository from '../repositories/post.repository';

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;

/**
 * Splits a long text into smaller chunks based on token size.
 * @param content The text content to be split.
 * @returns An array of text chunks.
 */
export const chunkText = (content: string): string[] => {
  const tokenizer = get_encoding('cl100k_base');
  const sentences = content.split(/(?<=[.?!])\s+/);
  const chunks: string[] = [];
  const textDecoder = new TextDecoder();

  let currentChunk: number[] = [];

  for (const sentence of sentences) {
    const sentenceTokens = tokenizer.encode(sentence);
    if (currentChunk.length + sentenceTokens.length > CHUNK_SIZE) {
      const decodedBytes = tokenizer.decode(new Uint32Array(currentChunk));
      chunks.push(textDecoder.decode(decodedBytes));
      currentChunk = currentChunk.slice(currentChunk.length - CHUNK_OVERLAP);
    }
    currentChunk.push(...sentenceTokens);
  }

  if (currentChunk.length > 0) {
    const decodedBytes = tokenizer.decode(new Uint32Array(currentChunk));
    chunks.push(textDecoder.decode(decodedBytes));
  }

  return chunks;
};

/**
 * Creates vector embeddings for an array of texts.
 * @param texts The texts to be embedded.
 * @returns A promise that resolves to an array of embeddings.
 */
export const createEmbeddings = async (texts: string[]): Promise<number[][]> => {
  const response = await openai.embeddings.create({
    model: config.EMBED_MODEL,
    input: texts,
  });
  return response.data.map((item) => item.embedding);
};

/**
 * Creates and stores the title embedding for a post.
 * @param postId The ID of the post.
 * @param title The title of the post.
 */
export const storeTitleEmbedding = async (postId: number, title: string) => {
  const [embedding] = await createEmbeddings([title]);
  await postRepository.storeTitleEmbedding(postId, embedding);
};

/**
 * Stores the content embeddings for a post.
 * @param postId The ID of the post.
 * @param chunks The text chunks of the content.
 * @param embeddings The vector embeddings of the chunks.
 */
export const storeContentEmbeddings = async (
  postId: number,
  chunks: string[],
  embeddings: number[][]
) => {
  await postRepository.storeContentEmbeddings(postId, chunks, embeddings);
};