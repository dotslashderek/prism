import { createLogger } from '@stoplight/prism-core';

// -- Mocks --
jest.mock('../providers/config', () => ({
  createChatModel: jest.fn().mockReturnValue({
    withStructuredOutput: jest.fn().mockReturnValue({
      invoke: jest.fn(),
    }),
  }),
  createEmbeddingModel: jest.fn().mockReturnValue({ embedQuery: jest.fn() }),
}));

jest.mock('../memory/embedder', () => ({
  Embedder: jest.fn().mockImplementation(() => ({
    embed: jest.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3, 0.4])),
  })),
}));

jest.mock('../agents/generator-agent', () => ({
  generatorAgent: jest.fn(),
}));

import { MemoryStore } from '../memory/store';
import { Embedder } from '../memory/embedder';
import { summarize } from '../memory/summarizer';
import { createChatModel } from '../providers/config';
import { generatorAgent } from '../agents/generator-agent';
import { buildPlannerPrompt, planSeed } from '../seed/planner';
import { resolvePlaceholders, computeBackdatedTimestamp, materializeSeed } from '../seed/materializer';
import { initializeAiMocker } from '../seed';
import type { SeedPlan } from '../seed/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const mockGeneratorAgent = generatorAgent as jest.MockedFunction<typeof generatorAgent>;
const logger = createLogger('TEST', { enabled: false });

/** Create a mock chat model with configurable withStructuredOutput. */
const mockChatModel = (overrides?: { withStructuredOutput?: jest.Mock }): BaseChatModel =>
  ({ withStructuredOutput: overrides?.withStructuredOutput ?? jest.fn() }) as unknown as BaseChatModel;

/** Create a mock chat model whose structured output returns the given plan. */
const mockChatModelWithPlan = (plan: SeedPlan): BaseChatModel => {
  const mockInvoke = jest.fn().mockResolvedValue(plan);
  return { withStructuredOutput: jest.fn().mockReturnValue({ invoke: mockInvoke }) } as unknown as BaseChatModel;
};

/** Create a mock Embedder (avoids the null-as-any for the underlying model). */
const mockEmbedder = (): Embedder =>
  new Embedder(undefined as unknown as ConstructorParameters<typeof Embedder>[0]);

const DIM = 4;

const makeOperations = () => [
  { method: 'GET', path: '/users' },
  { method: 'POST', path: '/users' },
  { method: 'GET', path: '/users/{userId}' },
  { method: 'PUT', path: '/users/{userId}' },
  { method: 'DELETE', path: '/users/{userId}' },
  { method: 'GET', path: '/posts' },
  { method: 'POST', path: '/posts' },
];

const makeSeedPlan = (): SeedPlan => ({
  steps: [
    { method: 'POST', path: '/users', description: 'Create a user' },
    { method: 'GET', path: '/users/$id', description: 'Read the created user', dependsOnStep: 1 },
    { method: 'POST', path: '/posts', description: 'Create a post' },
  ],
});

// ------------------------------------------------------------------
// 1. Planner — buildPlannerPrompt
// ------------------------------------------------------------------
describe('Seed Planner', () => {
  describe('buildPlannerPrompt', () => {
    it('includes all operations in the prompt', () => {
      const ops = makeOperations();
      const prompt = buildPlannerPrompt(ops);

      expect(prompt).toContain('GET /users');
      expect(prompt).toContain('POST /users');
      expect(prompt).toContain('DELETE /users/{userId}');
    });

    it('includes scenarios context when provided', () => {
      const ops = makeOperations();
      const prompt = buildPlannerPrompt(ops, 'Swedish users only');

      expect(prompt).toContain('Swedish users only');
      expect(prompt).toContain('User Context');
    });

    it('omits scenarios context section when not provided', () => {
      const ops = makeOperations();
      const prompt = buildPlannerPrompt(ops);

      expect(prompt).not.toContain('User Context');
    });
  });

  describe('planSeed', () => {
    it('calls chatModel.withStructuredOutput and returns a SeedPlan', async () => {
      const expectedPlan = makeSeedPlan();
      const mockInvoke = jest.fn().mockResolvedValue(expectedPlan);
      const mockStructured = jest.fn().mockReturnValue({ invoke: mockInvoke });
      const chatModel = mockChatModel({ withStructuredOutput: mockStructured });

      const result = await planSeed(makeOperations(), chatModel, logger);

      expect(mockStructured).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'object' }),
        expect.objectContaining({ name: 'generate_seed_plan' }),
      );
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].method).toBe('POST');
    });
  });
});

// ------------------------------------------------------------------
// 2. Materializer — utilities
// ------------------------------------------------------------------
describe('Seed Materializer', () => {
  describe('resolvePlaceholders', () => {
    it('replaces $id with the id from a prior step response', () => {
      const responses = [{ id: 42, name: 'Alice' }];
      const result = resolvePlaceholders('/users/$id', 1, responses);
      expect(result).toBe('/users/42');
    });

    it('returns path unchanged when no dependsOnStep', () => {
      const result = resolvePlaceholders('/users', undefined, []);
      expect(result).toBe('/users');
    });

    it('returns path unchanged when prior response has no id', () => {
      const responses = [{ name: 'Alice' }];
      const result = resolvePlaceholders('/users/$id', 1, responses);
      expect(result).toBe('/users/$id');
    });

    it('handles out-of-range dependsOnStep gracefully', () => {
      const result = resolvePlaceholders('/users/$id', 5, [{ id: 1 }]);
      expect(result).toBe('/users/$id');
    });
  });

  describe('computeBackdatedTimestamp', () => {
    it('returns timestamps spread over the last 24 hours', () => {
      const now = Date.now();
      const totalSteps = 5;
      const t0 = computeBackdatedTimestamp(0, totalSteps);
      const t4 = computeBackdatedTimestamp(4, totalSteps);
      const oneDayMs = 24 * 60 * 60 * 1000;
      const interval = oneDayMs / totalSteps;

      // t0 should be ~24h ago
      expect(t0).toBeGreaterThan(now - oneDayMs - 1000);
      expect(t0).toBeLessThan(now - oneDayMs + interval + 1000);
      // t4 should be close to now (within one interval)
      expect(t4).toBeGreaterThan(now - interval * 1.1);
      expect(t4).toBeLessThan(now);
      // Order must be preserved
      expect(t4).toBeGreaterThan(t0);
    });
  });

  describe('materializeSeed', () => {
    let store: MemoryStore;
    let embedder: Embedder;

    beforeEach(() => {
      store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM });
      embedder = mockEmbedder();
      jest.clearAllMocks();
      mockGeneratorAgent.mockResolvedValue({
        body: { id: 1, name: 'Test User' },
        compliant: true,
        source: 'llm',
      });
    });

    afterEach(() => {
      store.close();
    });

    it('persists interactions with backdated timestamps', async () => {
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      const plan = makeSeedPlan();
      const chatModel = mockChatModel();

      const result = await materializeSeed(plan, makeOperations(), {
        store,
        embedder,
        summarizer: summarize,
        chatModel,
        logger,
      });

      expect(result.stepsExecuted).toBe(3);
      expect(store.hasInteractions()).toBe(true);

      // Use search to get stored interactions and verify timestamps are backdated
      const queryEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      const results = store.search(queryEmbedding, '/users', 10, 0);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.createdAt).toBeLessThan(now);
        expect(r.createdAt).toBeGreaterThan(now - oneDayMs - 1000);
      }
    });

    it('resolves $id from prior step responses', async () => {
      mockGeneratorAgent
        .mockResolvedValueOnce({ body: { id: 99, name: 'Alice' }, compliant: true, source: 'llm' })
        .mockResolvedValueOnce({ body: { id: 99, name: 'Alice' }, compliant: true, source: 'llm' })
        .mockResolvedValueOnce({ body: { id: 1, title: 'Post' }, compliant: true, source: 'llm' });

      const plan = makeSeedPlan();
      const chatModel = mockChatModel();

      await materializeSeed(plan, makeOperations(), {
        store,
        embedder,
        summarizer: summarize,
        chatModel,
        logger,
      });

      // The generator should have been called 3 times
      expect(mockGeneratorAgent).toHaveBeenCalledTimes(3);

      // Second call (GET /users/$id) should have resolved path to /users/99
      const secondCallArgs = mockGeneratorAgent.mock.calls[1][0];
      expect(secondCallArgs.request.path).toBe('/users/99');
    });

    it('continues on individual step failure', async () => {
      mockGeneratorAgent
        .mockResolvedValueOnce({ body: { id: 1 }, compliant: true, source: 'llm' })
        .mockRejectedValueOnce(new Error('LLM boom'))
        .mockResolvedValueOnce({ body: { id: 2 }, compliant: true, source: 'llm' });

      const plan = makeSeedPlan();
      const chatModel = mockChatModel();

      const result = await materializeSeed(plan, makeOperations(), {
        store,
        embedder,
        summarizer: summarize,
        chatModel,
        logger,
      });

      // 2 out of 3 should succeed
      expect(result.stepsExecuted).toBe(2);
    });

    it('returns seeded resource keys', async () => {
      const plan = makeSeedPlan();
      const chatModel = mockChatModel();

      const result = await materializeSeed(plan, makeOperations(), {
        store,
        embedder,
        summarizer: summarize,
        chatModel,
        logger,
      });

      expect(result.resourcesSeeded).toContain('/users');
      expect(result.resourcesSeeded).toContain('/posts');
    });
  });
});

// ------------------------------------------------------------------
// 3. Orchestrator — initializeAiMocker
// ------------------------------------------------------------------
describe('initializeAiMocker', () => {
  let store: MemoryStore;
  let embedder: Embedder;

  beforeEach(() => {
    store = new MemoryStore({ dbPath: ':memory:', dimensions: DIM });
    embedder = mockEmbedder();
    mockGeneratorAgent.mockResolvedValue({
      body: { id: 1, name: 'Test' },
      compliant: true,
      source: 'llm',
    });
  });

  afterEach(() => {
    store.close();
  });

  it('skips seeding when store already has interactions', async () => {
    // Pre-populate store
    store.store({
      operation: 'POST /users',
      method: 'POST',
      path: '/users',
      resourceKey: '/users',
      reqSummary: 'test',
      resSummary: 'test',
      resBody: '{}',
      embedding: new Float32Array(DIM),
      isDeletion: false,
      createdAt: Date.now(),
    });

    const mockInvoke = jest.fn();
    const chatModel = { withStructuredOutput: jest.fn().mockReturnValue({ invoke: mockInvoke }) } as unknown as BaseChatModel;

    const result = await initializeAiMocker(makeOperations(), {
      store,
      embedder,
      summarizer: summarize,
      chatModel,
      logger,
    });

    expect(result).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('seeds when store is empty', async () => {
    const plan = makeSeedPlan();
    const chatModel = mockChatModelWithPlan(plan);

    const result = await initializeAiMocker(makeOperations(), {
      store,
      embedder,
      summarizer: summarize,
      chatModel,
      logger,
    });

    expect(result).not.toBeNull();
    expect(result!.stepsExecuted).toBe(3);
    expect(store.hasInteractions()).toBe(true);
  });

  it('clears memory before seeding when clearMemory is true', async () => {
    // Pre-populate
    store.store({
      operation: 'OLD',
      method: 'GET',
      path: '/old',
      resourceKey: '/old',
      reqSummary: 'old',
      resSummary: 'old',
      resBody: '{}',
      embedding: new Float32Array(DIM),
      isDeletion: false,
      createdAt: Date.now(),
    });

    const plan = makeSeedPlan();
    const chatModel = mockChatModelWithPlan(plan);

    const result = await initializeAiMocker(
      makeOperations(),
      { store, embedder, summarizer: summarize, chatModel, logger },
      { clearMemory: true },
    );

    expect(result).not.toBeNull();
    expect(result!.stepsExecuted).toBe(3);

    // Old data should be gone — search for /old resource should return nothing
    const oldQuery = new Float32Array(DIM);
    const oldResults = store.search(oldQuery, '/old', 10, 0);
    expect(oldResults).toHaveLength(0);

    // But seed data should be present
    expect(store.hasInteractions()).toBe(true);
  });

  it('handles timeout gracefully', async () => {
    const mockInvoke = jest.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const chatModel = { withStructuredOutput: jest.fn().mockReturnValue({ invoke: mockInvoke }) } as unknown as BaseChatModel;

    const result = await initializeAiMocker(
      makeOperations(),
      { store, embedder, summarizer: summarize, chatModel, logger },
      { timeoutMs: 50 }, // Very short timeout
    );

    expect(result).toBeNull();
  });
});
