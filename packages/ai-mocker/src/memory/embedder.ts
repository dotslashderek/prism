import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import type { Embeddings } from '@langchain/core/embeddings';

const CACHE_MAX = 500;

/**
 * LRU-cached embedding wrapper around a LangChain Embeddings instance.
 *
 * - Caches results by sha256(text) to avoid duplicate API calls
 * - Returns `Float32Array` for direct compatibility with `MemoryStore`
 */
export class Embedder {
  private readonly embeddings: Embeddings;
  private readonly cache: LRUCache<string, Float32Array>;

  constructor(embeddings: Embeddings) {
    this.embeddings = embeddings;
    this.cache = new LRUCache<string, Float32Array>({ max: CACHE_MAX });
  }

  /**
   * Embed text into a Float32Array vector.
   *
   * Uses sha256 of the input as cache key. On cache miss, calls the
   * underlying LangChain embeddings provider and converts `number[]`
   * to `Float32Array`.
   */
  async embed(text: string): Promise<Float32Array> {
    const key = createHash('sha256').update(text).digest('hex');

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const raw: number[] = await this.embeddings.embedQuery(text);
    const result = new Float32Array(raw);

    this.cache.set(key, result);

    return result;
  }
}
