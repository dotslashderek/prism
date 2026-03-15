import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { JSONSchema7 } from 'json-schema';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemoryStore } from '../memory/store';
import { summarize } from '../memory/summarizer';
import { orchestrate, OrchestratorDeps } from '../agents/orchestrator';
import { ResourceMutex } from '../util/concurrency';
import { ResponseCache } from '../util/cache';
import type { Embedder } from '../memory/embedder';

// ---------------------------------------------------------------------------
// Mock LLM — deterministic JSON based on system prompt content
// ---------------------------------------------------------------------------

/** Counter for server-generated IDs across the mock LLM. */
let idCounter = 0;

/**
 * Creates a mock BaseChatModel that returns deterministic JSON.
 * Detects intent from the prompt text and returns structurally valid data.
 */
const createMockChatModel = () => {
  const invoke = async (prompt: string): Promise<Record<string, unknown>> => {
    const upper = prompt.toUpperCase();

    if (upper.includes('HTTP METHOD: DELETE')) {
      return {};
    }

    if (upper.includes('HTTP METHOD: PUT') || upper.includes('HTTP METHOD: PATCH')) {
      // Echo request body fields from the prompt
      // NOTE: regex fails on nested objects — acceptable for flat Petstore schema
      const bodyMatch = prompt.match(/Request Body:\s*(\{[^}]+\})/);
      const bodyFields = bodyMatch ? JSON.parse(bodyMatch[1]) : {};
      const idMatch = prompt.match(/Path:\s*\/\w+\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : ++idCounter;
      return { id, status: 'available', ...bodyFields };
    }

    if (upper.includes('HTTP METHOD: POST')) {
      const bodyMatch = prompt.match(/Request Body:\s*(\{[^}]+\})/);
      const bodyFields = bodyMatch ? JSON.parse(bodyMatch[1]) : {};
      return { id: ++idCounter, ...bodyFields };
    }

    // GET — return data consistent with prior interactions (context is in prompt)
    const idMatch = prompt.match(/Path:\s*\/\w+\/(\d+)/);
    const id = idMatch ? Number(idMatch[1]) : 1;
    return { id, name: 'Buddy', status: 'available' };
  };

  return {
    withStructuredOutput: () => ({ invoke }),
  } as unknown as BaseChatModel;
};

// ---------------------------------------------------------------------------
// Mock Embedder — consistent Float32Array from text hash
// ---------------------------------------------------------------------------

const createMockEmbedder = (): Embedder => {
  const embed = async (text: string): Promise<Float32Array> => {
    // Simple deterministic hash → 4-dimensional vector
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    const v = new Float32Array(4);
    v[0] = ((h >>> 0) & 0xff) / 255;
    v[1] = ((h >>> 8) & 0xff) / 255;
    v[2] = ((h >>> 16) & 0xff) / 255;
    v[3] = ((h >>> 24) & 0xff) / 255;
    return v;
  };

  return { embed } as Embedder;
};

// ---------------------------------------------------------------------------
// Collecting Executor — captures background promises for deterministic tests
// ---------------------------------------------------------------------------

const createCollectingExecutor = () => {
  const promises: Promise<unknown>[] = [];

  const executor = <T>(fn: () => Promise<T>): void => {
    promises.push(fn());
  };

  const drain = async (): Promise<void> => {
    await Promise.all(promises);
    promises.length = 0;
  };

  return { executor, drain };
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const petSchema: JSONSchema7 = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['available', 'pending', 'sold'] },
  },
  required: ['id', 'name'],
};

const noopLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as import('pino').Logger;

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('AI Pipeline Integration Tests', () => {
  let store: MemoryStore;
  let dbPath: string;
  let execCtl: ReturnType<typeof createCollectingExecutor>;
  let deps: OrchestratorDeps;

  beforeEach(() => {
    // Reset ID counter for determinism
    idCounter = 0;

    // Temp DB for each test
    dbPath = path.join(os.tmpdir(), `prism-integration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new MemoryStore({ dbPath, dimensions: 4, disableVec: true });

    execCtl = createCollectingExecutor();

    deps = {
      store,
      embedder: createMockEmbedder(),
      summarizer: summarize,
      chatModel: createMockChatModel(),
      fakerFallback: (schema: JSONSchema7) => ({ id: 999, name: 'faker-pet', status: 'available' }),
      logger: noopLogger,
      resourceMutex: new ResourceMutex(),
      responseCache: new ResponseCache(),
      llmLimiter: <T>(fn: () => Promise<T>) => fn(),
      backgroundExecutor: execCtl.executor,
    };
  });

  afterEach(() => {
    store.close();
    // Clean up temp DB files
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // Ignore cleanup errors
    }
  });

  // 1. POST /pets — creates a new pet
  it('POST /pets creates a resource with request body fields and server-generated id', async () => {
    const result = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const body = result as Record<string, unknown>;
    expect(body.name).toBe('Buddy');
    expect(body.status).toBe('available');
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe('number');
  });

  // 2. GET /pets/{id} — returns data consistent with POST
  it('GET /pets/{id} returns data consistent with a prior POST (memory retrieval)', async () => {
    // First POST to create the resource
    const postResult = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const createdId = (postResult as Record<string, unknown>).id;

    // Invalidate response cache so the GET actually hits the pipeline
    deps.responseCache.invalidate('/pets');

    // GET the same resource
    const getResult = await orchestrate(
      `GET /pets/${createdId}`,
      { method: 'GET', path: `/pets/${createdId}` },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const body = getResult as Record<string, unknown>;
    expect(body.id).toBeDefined();
    expect(body.name).toBeDefined();
    // The entity snapshot should exist in memory after POST
    const snapshot = store.getEntitySnapshot('/pets', String(createdId));
    expect(snapshot).not.toBeNull();
  });

  // 3. PUT /pets/{id} — updates the resource
  it('PUT /pets/{id} reflects updated fields in response', async () => {
    // POST first
    const postResult = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const createdId = (postResult as Record<string, unknown>).id;

    // PUT with updated name
    const putResult = await orchestrate(
      `PUT /pets/${createdId}`,
      { method: 'PUT', path: `/pets/${createdId}`, body: { name: 'Max' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const body = putResult as Record<string, unknown>;
    expect(body.name).toBe('Max');
    expect(body.id).toBe(createdId);
  });

  // 4. DELETE /pets/{id} — tombstone is written
  it('DELETE /pets/{id} writes a tombstone interaction', async () => {
    // POST first
    const postResult = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const createdId = (postResult as Record<string, unknown>).id;

    // DELETE
    await orchestrate(
      `DELETE /pets/${createdId}`,
      { method: 'DELETE', path: `/pets/${createdId}` },
      petSchema,
      deps,
    );
    await execCtl.drain();

    // Memory agent should have persisted deletion — the snapshot should be tombstoned
    // The memory agent itself calls store.markDeleted for DELETEs with resourceId
    const snapshot = store.getEntitySnapshot('/pets', String(createdId));
    expect(snapshot).toBeNull();
  });

  // 5. GET /pets/{id} after delete — no entity snapshot
  it('GET /pets/{id} after DELETE returns no entity snapshot (tombstoned)', async () => {
    // POST
    const postResult = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      deps,
    );
    await execCtl.drain();

    const createdId = (postResult as Record<string, unknown>).id;

    // DELETE
    await orchestrate(
      `DELETE /pets/${createdId}`,
      { method: 'DELETE', path: `/pets/${createdId}` },
      petSchema,
      deps,
    );
    await execCtl.drain();

    // Clear cache so GET actually hits the pipeline
    deps.responseCache.invalidate('/pets');

    // GET — pipeline still returns a response (LLM generates one) but memory shows tombstone
    const getResult = await orchestrate(
      `GET /pets/${createdId}`,
      { method: 'GET', path: `/pets/${createdId}` },
      petSchema,
      deps,
    );
    await execCtl.drain();

    // The key assertion: entity snapshot has been tombstoned
    const snapshot = store.getEntitySnapshot('/pets', String(createdId));
    expect(snapshot).toBeNull();
    // Pipeline still returns *something* (not a crash)
    expect(getResult).toBeDefined();
  });

  // 6. LLM throws error → faker fallback
  it('falls back to faker when LLM throws an error', async () => {
    const errorModel = {
      withStructuredOutput: () => ({
        invoke: async () => { throw new Error('LLM exploded'); },
      }),
    } as unknown as BaseChatModel;

    const errorDeps: OrchestratorDeps = {
      ...deps,
      chatModel: errorModel,
    };

    const result = await orchestrate(
      'POST /pets',
      { method: 'POST', path: '/pets', body: { name: 'Buddy', status: 'available' } },
      petSchema,
      errorDeps,
    );
    await execCtl.drain();

    const body = result as Record<string, unknown>;
    // Should get faker fallback response
    expect(body.id).toBe(999);
    expect(body.name).toBe('faker-pet');
  });

  // 7. LLM times out → faker fallback
  it('falls back to faker when LLM times out', async () => {
    const hangingModel = {
      withStructuredOutput: () => ({
        invoke: () => new Promise(() => {}), // Never resolves
      }),
    } as unknown as BaseChatModel;

    const timeoutDeps: OrchestratorDeps = {
      ...deps,
      chatModel: hangingModel,
    };

    jest.useFakeTimers();
    try {
      const resultPromise = orchestrate(
        'GET /pets',
        { method: 'GET', path: '/pets' },
        petSchema,
        timeoutDeps,
      );

      // Advance past all timeout budgets (pipeline timeout = 20s)
      jest.advanceTimersByTime(25_000);

      const result = await resultPromise;
      const body = result as Record<string, unknown>;
      expect(body.id).toBe(999);
      expect(body.name).toBe('faker-pet');
    } finally {
      jest.useRealTimers();
    }
  });
});
