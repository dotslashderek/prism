import * as E from 'fp-ts/Either';
import { createLogger } from '@stoplight/prism-core';
import { JSONSchema7 } from 'json-schema';

// Mock downstream modules before importing index
jest.mock('../providers/config', () => ({
  createChatModel: jest.fn().mockReturnValue({ withStructuredOutput: jest.fn() }),
  createEmbeddingModel: jest.fn().mockReturnValue({ embedQuery: jest.fn() }),
}));

jest.mock('../memory/store', () => ({
  MemoryStore: jest.fn().mockImplementation(() => ({
    store: jest.fn(),
    search: jest.fn().mockReturnValue([]),
    getEntitySnapshot: jest.fn().mockReturnValue(null),
    markDeleted: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('../memory/embedder', () => ({
  Embedder: jest.fn().mockImplementation(() => ({
    embed: jest.fn().mockResolvedValue(new Float32Array([0.1, 0.2])),
  })),
}));

jest.mock('../agents/orchestrator', () => ({
  orchestrate: jest.fn(),
}));

import { createAiPayloadGenerator, _resetSingletons, AsyncPayloadGenerator } from '../index';
import { orchestrate } from '../agents/orchestrator';

const mockOrchestrate = orchestrate as jest.MockedFunction<typeof orchestrate>;
const logger = createLogger('TEST', { enabled: false });

describe('createAiPayloadGenerator', () => {
  const simpleSchema: JSONSchema7 = {
    type: 'object',
    title: 'User',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  };

  const fakeFallback = (schema: JSONSchema7): E.Either<Error, unknown> =>
    E.right({ name: 'faker-generated' });

  const failingFallback = (_schema: JSONSchema7): E.Either<Error, unknown> =>
    E.left(new Error('fallback error'));

  beforeEach(() => {
    jest.clearAllMocks();
    _resetSingletons();
  });

  it('returns a function matching AsyncPayloadGenerator signature', () => {
    const generator = createAiPayloadGenerator(fakeFallback, logger);
    expect(typeof generator).toBe('function');
  });

  it('calls orchestrate and returns the result as TaskEither Right', async () => {
    mockOrchestrate.mockResolvedValue({ name: 'ai-generated' });

    const generator = createAiPayloadGenerator(fakeFallback, logger);
    const result = await generator(simpleSchema)();

    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      expect(result.right).toEqual({ name: 'ai-generated' });
    }
    expect(mockOrchestrate).toHaveBeenCalledTimes(1);
  });

  it('returns TaskEither Left when orchestrate throws', async () => {
    mockOrchestrate.mockRejectedValue(new Error('orchestrate boom'));

    const generator = createAiPayloadGenerator(fakeFallback, logger);
    const result = await generator(simpleSchema)();

    expect(E.isLeft(result)).toBe(true);
    if (E.isLeft(result)) {
      expect(result.left.message).toBe('orchestrate boom');
    }
  });

  it('passes schema title as operation in the request', async () => {
    mockOrchestrate.mockResolvedValue({ name: 'test' });

    const generator = createAiPayloadGenerator(fakeFallback, logger);
    await generator(simpleSchema)();

    expect(mockOrchestrate).toHaveBeenCalledWith(
      'User',
      expect.objectContaining({ method: 'GET', path: '/User' }),
      simpleSchema,
      expect.anything(),
    );
  });

  it('uses "unknown" as operation when schema has no title', async () => {
    mockOrchestrate.mockResolvedValue({ name: 'test' });
    const noTitleSchema: JSONSchema7 = { type: 'object', properties: { name: { type: 'string' } } };

    const generator = createAiPayloadGenerator(fakeFallback, logger);
    await generator(noTitleSchema)();

    expect(mockOrchestrate).toHaveBeenCalledWith(
      'unknown',
      expect.objectContaining({ path: '/unknown' }),
      noTitleSchema,
      expect.anything(),
    );
  });

  it('logs "AI mocker invoked" via the logger', async () => {
    mockOrchestrate.mockResolvedValue({ name: 'test' });
    const infoSpy = jest.fn();
    const spyLogger = { ...logger, info: infoSpy } as any;

    const generator = createAiPayloadGenerator(fakeFallback, spyLogger);
    await generator(simpleSchema)();

    expect(infoSpy).toHaveBeenCalledWith('AI mocker invoked');
  });
});
