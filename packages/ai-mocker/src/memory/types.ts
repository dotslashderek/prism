/** Core interaction record stored in the memory layer. */
export type Interaction = {
  readonly id?: number;
  /** Combined verb + path, e.g. "POST /users" */
  readonly operation: string;
  /** HTTP method, e.g. "POST" */
  readonly method: string;
  /** Full request path, e.g. "/users/123" */
  readonly path: string;
  /** Base resource path for grouping, e.g. "/users" */
  readonly resourceKey: string;
  /** Extracted resource identifier from path params, e.g. "123" */
  readonly resourceId?: string;
  /** Human-readable summary of the request */
  readonly reqSummary: string;
  /** Human-readable summary of the response */
  readonly resSummary: string;
  /** JSON-stringified request body */
  readonly reqBody?: string;
  /** JSON-stringified response body */
  readonly resBody: string;
  /** Embedding vector from the LLM */
  readonly embedding: Float32Array;
  /** True when this interaction represents a DELETE (tombstone) */
  readonly isDeletion?: boolean;
  /** Unix timestamp in milliseconds */
  readonly createdAt: number;
};

/** Search result — an interaction with its relevance score. */
export type SearchResult = Interaction & {
  /** Combined similarity + recency score (higher = more relevant) */
  readonly score: number;
};

/** Configuration options for MemoryStore. */
export type MemoryStoreOptions = {
  /** Path to the SQLite database file (use ":memory:" for tests) */
  readonly dbPath: string;
  /** Embedding vector dimensionality (default: 1536 for OpenAI) */
  readonly dimensions?: number;
  /** Force-disable sqlite-vec (for testing JS fallback) */
  readonly disableVec?: boolean;
};
