import { MemoryStore } from '..';
import { Interaction } from '../types';

/**
 * Helper to create a synthetic embedding of a given dimension.
 * Fills with a base value so we can control similarity.
 */
const makeEmbedding = (dim: number, baseValue: number): Float32Array => {
  const arr = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    arr[i] = baseValue + i * 0.01;
  }
  return arr;
};

/** Creates a minimal valid Interaction for testing. */
const makeInteraction = (overrides: Partial<Interaction> = {}): Omit<Interaction, 'id'> => ({
  operation: 'POST /users',
  method: 'POST',
  path: '/users',
  resourceKey: '/users',
  reqSummary: 'Create a user',
  resSummary: 'Created user 1',
  resBody: JSON.stringify({ id: 1, name: 'Alice' }),
  embedding: makeEmbedding(4, 0.1),
  createdAt: Date.now(),
  ...overrides,
});

const DIM = 4;

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM });
  });

  afterEach(() => {
    store.close();
  });

  // ------------------------------------------------------------------
  // 1. CRUD — store and retrieve interactions
  // ------------------------------------------------------------------
  describe('store and retrieve', () => {
    it('stores an interaction and returns it with an assigned id', () => {
      const interaction = makeInteraction();
      const stored = store.store(interaction);

      expect(stored.id).toBeDefined();
      expect(typeof stored.id).toBe('number');
      expect(stored.operation).toBe(interaction.operation);
      expect(stored.resBody).toBe(interaction.resBody);
    });

    it('stores multiple interactions with unique ids', () => {
      const a = store.store(makeInteraction({ operation: 'POST /users' }));
      const b = store.store(makeInteraction({ operation: 'GET /users' }));

      expect(a.id).not.toBe(b.id);
    });
  });

  // ------------------------------------------------------------------
  // 2. Vector search — returns results ranked by similarity
  // ------------------------------------------------------------------
  describe('search', () => {
    it('returns results ranked by similarity to the query embedding', () => {
      // Embedding close to query
      const close = makeEmbedding(DIM, 0.5);
      // Embedding far from query
      const far = makeEmbedding(DIM, 5.0);
      // Query
      const query = makeEmbedding(DIM, 0.5);

      store.store(makeInteraction({ embedding: far, resSummary: 'far' }));
      store.store(makeInteraction({ embedding: close, resSummary: 'close' }));

      const results = store.search(query, '/users', 10, 0);

      expect(results.length).toBe(2);
      // The "close" interaction should be first (higher score)
      expect(results[0].resSummary).toBe('close');
      expect(results[1].resSummary).toBe('far');
      // Scores should be positive and ordered
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });

  // ------------------------------------------------------------------
  // 3. Resource key filtering — search scoped to a specific resource
  // ------------------------------------------------------------------
  describe('resource key filtering', () => {
    it('only returns interactions matching the given resource key', () => {
      store.store(makeInteraction({ resourceKey: '/users', resSummary: 'user op' }));
      store.store(makeInteraction({ resourceKey: '/orders', resSummary: 'order op' }));

      const query = makeEmbedding(DIM, 0.1);
      const results = store.search(query, '/users', 10, 0);

      expect(results.length).toBe(1);
      expect(results[0].resSummary).toBe('user op');
    });
  });

  // ------------------------------------------------------------------
  // 4. Tombstones — deleted resources filtered properly
  // ------------------------------------------------------------------
  describe('tombstones', () => {
    it('getEntitySnapshot returns the latest interaction for a resource', () => {
      store.store(
        makeInteraction({
          resourceKey: '/users',
          resourceId: '1',
          resSummary: 'first',
          createdAt: 1000,
        }),
      );
      store.store(
        makeInteraction({
          resourceKey: '/users',
          resourceId: '1',
          resSummary: 'second',
          createdAt: 2000,
        }),
      );

      const snapshot = store.getEntitySnapshot('/users', '1');
      expect(snapshot).not.toBeNull();
      expect(snapshot!.resSummary).toBe('second');
    });

    it('getEntitySnapshot returns null when latest interaction is a deletion', () => {
      store.store(
        makeInteraction({
          resourceKey: '/users',
          resourceId: '42',
          createdAt: 1000,
        }),
      );
      store.markDeleted('/users', '42');

      const snapshot = store.getEntitySnapshot('/users', '42');
      expect(snapshot).toBeNull();
    });

    it('search excludes interactions for deleted resources', () => {
      const embedding = makeEmbedding(DIM, 0.1);

      store.store(
        makeInteraction({
          resourceKey: '/users',
          resourceId: '1',
          resSummary: 'alive',
          embedding,
        }),
      );
      store.store(
        makeInteraction({
          resourceKey: '/users',
          resourceId: '2',
          resSummary: 'will-die',
          embedding,
        }),
      );
      store.markDeleted('/users', '2');

      const results = store.search(embedding, '/users', 10, 0);

      const summaries = results.map(r => r.resSummary);
      expect(summaries).toContain('alive');
      expect(summaries).not.toContain('will-die');
    });
  });

  // ------------------------------------------------------------------
  // 5. Recency bias — newer interactions score higher when similarity equal
  // ------------------------------------------------------------------
  describe('recency bias', () => {
    it('ranks newer interactions higher when similarity is equal', () => {
      const embedding = makeEmbedding(DIM, 0.3);

      store.store(
        makeInteraction({
          embedding,
          resSummary: 'old',
          createdAt: Date.now() - 100_000,
        }),
      );
      store.store(
        makeInteraction({
          embedding,
          resSummary: 'new',
          createdAt: Date.now(),
        }),
      );

      const results = store.search(embedding, '/users', 10, 0);

      expect(results.length).toBe(2);
      expect(results[0].resSummary).toBe('new');
      expect(results[1].resSummary).toBe('old');
    });
  });

  // ------------------------------------------------------------------
  // 6. JS fallback — brute-force cosine search when sqlite-vec unavailable
  // ------------------------------------------------------------------
  describe('JS fallback search', () => {
    let fallbackStore: MemoryStore;

    beforeEach(() => {
      // Force fallback mode by passing the flag
      fallbackStore = new MemoryStore({
        dbPath: ':memory:',
        dimensions: DIM,
        disableVec: true,
      });
    });

    afterEach(() => {
      fallbackStore.close();
    });

    it('returns results ranked by similarity using JS cosine fallback', () => {
      const close = makeEmbedding(DIM, 0.5);
      const far = makeEmbedding(DIM, 5.0);
      const query = makeEmbedding(DIM, 0.5);

      fallbackStore.store(makeInteraction({ embedding: far, resSummary: 'far' }));
      fallbackStore.store(makeInteraction({ embedding: close, resSummary: 'close' }));

      const results = fallbackStore.search(query, '/users', 10, 0);

      expect(results.length).toBe(2);
      expect(results[0].resSummary).toBe('close');
      expect(results[1].resSummary).toBe('far');
    });
  });
});
