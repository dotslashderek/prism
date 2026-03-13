import { LRUCache } from 'lru-cache';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX = 200;

/**
 * Build a deterministic cache key from the operation, memory IDs, and schema hash.
 *
 * Memory IDs are sorted so that key order is consistent regardless of retrieval order.
 */
export const buildKey = (operationId: string, memoryIds: readonly number[], schemaHash: string): string => {
  const sorted = [...memoryIds].sort((a, b) => a - b).join(',');
  return `${operationId}:${sorted}:${schemaHash}`;
};

/**
 * LRU response cache with TTL-based expiration.
 *
 * Caches generated AI responses to avoid redundant LLM calls for
 * identical request contexts within the TTL window.
 */
export class ResponseCache {
  private readonly cache: LRUCache<string, unknown>;

  constructor(ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX) {
    this.cache = new LRUCache<string, unknown>({ max, ttl: ttlMs });
  }

  /** Retrieve a cached response body, or undefined on miss. */
  get(key: string): unknown | undefined {
    return this.cache.get(key);
  }

  /** Store a response body under the given key. */
  set(key: string, body: unknown): void {
    this.cache.set(key, body);
  }

  /**
   * Invalidate all cached entries whose key contains the given resource key.
   *
   * Called after mutations to ensure stale data isn't served.
   */
  invalidate(resourceKey: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(resourceKey)) {
        this.cache.delete(key);
      }
    }
  }
}
