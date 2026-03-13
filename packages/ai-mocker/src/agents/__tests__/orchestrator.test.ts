import type { ContextAgentOutput, HttpRequest } from '../types';
import type { JSONSchema7 } from 'json-schema';

// Mock the downstream agents before importing orchestrator
jest.mock('../context-agent', () => ({
  contextAgent: jest.fn(),
}));
jest.mock('../generator-agent', () => ({
  generatorAgent: jest.fn(),
}));
jest.mock('../memory-agent', () => ({
  memoryAgent: jest.fn(),
}));

import { orchestrate, OrchestratorDeps } from '../orchestrator';
import { contextAgent } from '../context-agent';
import { generatorAgent } from '../generator-agent';
import { memoryAgent } from '../memory-agent';

const mockContextAgent = contextAgent as jest.MockedFunction<typeof contextAgent>;
const mockGeneratorAgent = generatorAgent as jest.MockedFunction<typeof generatorAgent>;
const mockMemoryAgent = memoryAgent as jest.MockedFunction<typeof memoryAgent>;

describe('orchestrate', () => {
  const schema: JSONSchema7 = {
    type: 'object',
    properties: { id: { type: 'number' }, name: { type: 'string' } },
    required: ['id', 'name'],
  };

  const defaultContext: ContextAgentOutput = {
    memories: [],
    resourceKey: '/users',
    resourceId: undefined,
    pathParamConstraints: {},
  };

  const makeDeps = (): OrchestratorDeps => ({
    store: {} as any,
    embedder: {} as any,
    summarizer: jest.fn() as any,
    chatModel: {} as any,
    fakerFallback: jest.fn().mockReturnValue({ id: 99, name: 'faker-fallback' }),
    logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } as any,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockContextAgent.mockResolvedValue(defaultContext);
    mockGeneratorAgent.mockResolvedValue({
      body: { id: 1, name: 'Alice' },
      compliant: true,
      source: 'llm',
    });
    mockMemoryAgent.mockResolvedValue(undefined);
  });

  const makeRequest = (method: string, path: string, body?: unknown): HttpRequest => ({
    method,
    path,
    body,
  });

  it('chains context → generate → memory and returns generated body', async () => {
    const deps = makeDeps();
    const request = makeRequest('GET', '/users');

    const result = await orchestrate('GET /users', request, schema, deps);

    expect(result).toEqual({ id: 1, name: 'Alice' });
    expect(mockContextAgent).toHaveBeenCalledTimes(1);
    expect(mockGeneratorAgent).toHaveBeenCalledTimes(1);
    expect(mockMemoryAgent).toHaveBeenCalledTimes(1);
  });

  it('falls back to faker when generator returns source: fallback', async () => {
    const deps = makeDeps();
    mockGeneratorAgent.mockResolvedValue({
      body: undefined,
      compliant: false,
      source: 'fallback',
    });

    const result = await orchestrate('POST /users', makeRequest('POST', '/users'), schema, deps);

    expect(result).toEqual({ id: 99, name: 'faker-fallback' });
    expect(deps.fakerFallback).toHaveBeenCalledWith(schema);
  });

  it('falls back to faker when generator returns compliant: false', async () => {
    const deps = makeDeps();
    mockGeneratorAgent.mockResolvedValue({
      body: { bad: 'data' },
      compliant: false,
      source: 'llm',
    });

    const result = await orchestrate('POST /users', makeRequest('POST', '/users'), schema, deps);

    expect(result).toEqual({ id: 99, name: 'faker-fallback' });
    expect(deps.fakerFallback).toHaveBeenCalledWith(schema);
  });

  it('does not fall back when source is llm and compliant is true', async () => {
    const deps = makeDeps();

    await orchestrate('GET /users', makeRequest('GET', '/users'), schema, deps);

    expect(deps.fakerFallback).not.toHaveBeenCalled();
  });

  it('memory agent is called fire-and-forget (does not block return)', async () => {
    const deps = makeDeps();
    // Make memoryAgent take a long time — but orchestrate should not wait
    let resolveMemory!: () => void;
    mockMemoryAgent.mockReturnValue(new Promise<void>(r => { resolveMemory = r; }));

    const result = await orchestrate('GET /users', makeRequest('GET', '/users'), schema, deps);

    // Result should be available even though memory agent hasn't resolved
    expect(result).toEqual({ id: 1, name: 'Alice' });

    // Clean up
    resolveMemory();
  });

  describe('intent classification', () => {
    it.each([
      ['GET', 'read'],
      ['DELETE', 'deletion'],
      ['POST', 'mutation'],
      ['PUT', 'mutation'],
      ['PATCH', 'mutation'],
    ] as const)('%s → %s', async (method, expectedIntent) => {
      const deps = makeDeps();

      await orchestrate(`${method} /users`, makeRequest(method, '/users'), schema, deps);

      expect(mockGeneratorAgent).toHaveBeenCalledWith(
        expect.objectContaining({ intent: expectedIntent }),
        deps.chatModel,
      );
    });
  });

  it('passes correct context to generator agent', async () => {
    const deps = makeDeps();
    const request = makeRequest('GET', '/users');

    await orchestrate('GET /users', request, schema, deps);

    expect(mockGeneratorAgent).toHaveBeenCalledWith(
      {
        schema,
        request,
        context: defaultContext,
        intent: 'read',
      },
      deps.chatModel,
    );
  });

  it('passes response body to memory agent', async () => {
    const deps = makeDeps();
    const request = makeRequest('POST', '/users', { name: 'Bob' });

    await orchestrate('POST /users', request, schema, deps);

    expect(mockMemoryAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { id: 1, name: 'Alice' },
        method: 'POST',
        path: '/users',
        resourceKey: '/users',
      }),
      expect.objectContaining({
        store: deps.store,
        embedder: deps.embedder,
        summarizer: deps.summarizer,
      }),
      deps.logger,
    );
  });

  it('logs memory agent errors without crashing', async () => {
    const deps = makeDeps();
    const memoryError = new Error('memory boom');
    mockMemoryAgent.mockRejectedValue(memoryError);

    // Should not throw
    const result = await orchestrate('GET /users', makeRequest('GET', '/users'), schema, deps);
    expect(result).toEqual({ id: 1, name: 'Alice' });

    // Give the .catch handler a tick to run
    await new Promise(r => setTimeout(r, 10));
    expect(deps.logger.error).toHaveBeenCalledWith({ err: memoryError }, 'Memory agent failed');
  });
});
