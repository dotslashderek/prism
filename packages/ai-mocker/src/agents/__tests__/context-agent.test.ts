import { contextAgent } from '../context-agent';
import type { ContextAgentInput, ContextAgentOutput } from '../types';
import type { MemoryStore } from '../../memory/store';
import type { Embedder } from '../../memory/embedder';
import type { summarize } from '../../memory/summarizer';
import type { SearchResult, Interaction } from '../../memory/types';

/** Stub embedding vector. */
const STUB_EMBEDDING = new Float32Array([0.1, 0.2, 0.3]);

/** Create a mock MemoryStore with sensible defaults. */
const mockStore = (overrides: Partial<MemoryStore> = {}): MemoryStore =>
  ({
    search: jest.fn().mockReturnValue([]),
    getEntitySnapshot: jest.fn().mockReturnValue(null),
    ...overrides,
  }) as unknown as MemoryStore;

/** Create a mock Embedder. */
const mockEmbedder = (): Embedder =>
  ({
    embed: jest.fn().mockResolvedValue(STUB_EMBEDDING),
  }) as unknown as Embedder;

/** Create a mock summarizer. */
const mockSummarizer = (): typeof summarize =>
  jest.fn().mockReturnValue('[GET /users] request summary') as unknown as typeof summarize;

/** Factory for a SearchResult. */
const makeSearchResult = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  id: 1,
  operation: 'POST /users',
  method: 'POST',
  path: '/users',
  resourceKey: '/users',
  reqSummary: 'Create user',
  resSummary: 'Created user 1',
  resBody: JSON.stringify({ id: 1, name: 'Alice' }),
  embedding: STUB_EMBEDDING,
  createdAt: Date.now(),
  score: 0.85,
  ...overrides,
});

/** Factory for an Interaction (entity snapshot). */
const makeInteraction = (overrides: Partial<Interaction> = {}): Interaction => ({
  id: 1,
  operation: 'POST /users',
  method: 'POST',
  path: '/users/1',
  resourceKey: '/users',
  resourceId: '1',
  reqSummary: 'Create user',
  resSummary: 'Created user 1',
  resBody: JSON.stringify({ id: 1, name: 'Alice' }),
  embedding: STUB_EMBEDDING,
  createdAt: Date.now(),
  ...overrides,
});

describe('contextAgent', () => {
  // ----------------------------------------------------------------
  // Cold start — no stored interactions
  // ----------------------------------------------------------------
  describe('cold start', () => {
    it('returns empty memories and no entity snapshot', async () => {
      const input: ContextAgentInput = {
        operation: 'GET /users',
        request: { method: 'GET', path: '/users' },
      };

      const result = await contextAgent(input, {
        store: mockStore(),
        embedder: mockEmbedder(),
        summarizer: mockSummarizer(),
      });

      expect(result.memories).toEqual([]);
      expect(result.entitySnapshot).toBeUndefined();
      expect(result.resourceKey).toBe('/users');
      expect(result.resourceId).toBeUndefined();
      expect(result.pathParamConstraints).toEqual({});
    });
  });

  // ----------------------------------------------------------------
  // Retrieval — search returns results
  // ----------------------------------------------------------------
  describe('retrieval', () => {
    it('maps search results to Memory objects', async () => {
      const now = Date.now();
      const searchResults: SearchResult[] = [
        makeSearchResult({ score: 0.9, operation: 'POST /users', createdAt: now - 1000 }),
        makeSearchResult({ score: 0.7, operation: 'PUT /users', createdAt: now - 2000 }),
      ];

      const store = mockStore({ search: jest.fn().mockReturnValue(searchResults) });

      const input: ContextAgentInput = {
        operation: 'GET /users',
        request: { method: 'GET', path: '/users' },
      };

      const result = await contextAgent(input, {
        store,
        embedder: mockEmbedder(),
        summarizer: mockSummarizer(),
      });

      expect(result.memories).toHaveLength(2);
      expect(result.memories[0].score).toBe(0.9);
      expect(result.memories[0].operation).toBe('POST /users');
      expect(result.memories[1].score).toBe(0.7);
    });

    it('calls store.search with the embedded query, resourceKey, limit 5, threshold 0.5', async () => {
      const store = mockStore();
      const embedder = mockEmbedder();

      const input: ContextAgentInput = {
        operation: 'GET /users',
        request: { method: 'GET', path: '/users' },
      };

      await contextAgent(input, { store, embedder, summarizer: mockSummarizer() });

      expect(store.search).toHaveBeenCalledWith(STUB_EMBEDDING, '/users', 5, 0.5);
    });
  });

  // ----------------------------------------------------------------
  // Entity snapshot — GET by ID
  // ----------------------------------------------------------------
  describe('entity snapshot', () => {
    it('includes entity snapshot for GET-by-id paths', async () => {
      const snapshot = makeInteraction({ resourceId: '42', resBody: '{"id":42,"name":"Bob"}' });
      const store = mockStore({ getEntitySnapshot: jest.fn().mockReturnValue(snapshot) });

      const input: ContextAgentInput = {
        operation: 'GET /users/42',
        request: { method: 'GET', path: '/users/42' },
      };

      const result = await contextAgent(input, {
        store,
        embedder: mockEmbedder(),
        summarizer: mockSummarizer(),
      });

      expect(result.entitySnapshot).toBeDefined();
      expect(result.entitySnapshot!.resourceId).toBe('42');
      expect(result.entitySnapshot!.lastBody).toBe('{"id":42,"name":"Bob"}');
      expect(store.getEntitySnapshot).toHaveBeenCalledWith('/users', '42');
    });

    it('does not call getEntitySnapshot for collection endpoints', async () => {
      const store = mockStore();

      const input: ContextAgentInput = {
        operation: 'GET /users',
        request: { method: 'GET', path: '/users' },
      };

      await contextAgent(input, {
        store,
        embedder: mockEmbedder(),
        summarizer: mockSummarizer(),
      });

      expect(store.getEntitySnapshot).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Nested paths
  // ----------------------------------------------------------------
  describe('nested paths', () => {
    it('correctly parses /users/123/posts/456', async () => {
      const store = mockStore();

      const input: ContextAgentInput = {
        operation: 'GET /users/123/posts/456',
        request: {
          method: 'GET',
          path: '/users/123/posts/456',
          pathParams: { userId: '123', postId: '456' },
        },
      };

      const result = await contextAgent(input, {
        store,
        embedder: mockEmbedder(),
        summarizer: mockSummarizer(),
      });

      expect(result.resourceKey).toBe('/users/123/posts');
      expect(result.resourceId).toBe('456');
      expect(result.pathParamConstraints).toEqual({ userId: '123', postId: '456' });
      expect(store.search).toHaveBeenCalledWith(STUB_EMBEDDING, '/users/123/posts', 5, 0.5);
      expect(store.getEntitySnapshot).toHaveBeenCalledWith('/users/123/posts', '456');
    });
  });

  // ----------------------------------------------------------------
  // Request body serialization
  // ----------------------------------------------------------------
  describe('request body handling', () => {
    it('passes stringified body to summarizer', async () => {
      const summarizer = mockSummarizer();

      const input: ContextAgentInput = {
        operation: 'POST /users',
        request: { method: 'POST', path: '/users', body: { name: 'Alice' } },
      };

      await contextAgent(input, {
        store: mockStore(),
        embedder: mockEmbedder(),
        summarizer,
      });

      expect(summarizer).toHaveBeenCalledWith('POST', '/users', '{"name":"Alice"}');
    });

    it('passes undefined to summarizer when no body', async () => {
      const summarizer = mockSummarizer();

      const input: ContextAgentInput = {
        operation: 'GET /users',
        request: { method: 'GET', path: '/users' },
      };

      await contextAgent(input, {
        store: mockStore(),
        embedder: mockEmbedder(),
        summarizer,
      });

      expect(summarizer).toHaveBeenCalledWith('GET', '/users', undefined);
    });
  });
});
