import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { createLogger } from '@stoplight/prism-core';
import { createAiPayloadGenerator, AsyncPayloadGenerator } from '../index';
import { JSONSchema7 } from 'json-schema';

const logger = createLogger('TEST', { enabled: false });

describe('createAiPayloadGenerator', () => {
  const simpleSchema: JSONSchema7 = {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  };

  const fakeFallback = (schema: JSONSchema7): E.Either<Error, unknown> => {
    return E.right({ name: 'faker-generated' });
  };

  const failingFallback = (_schema: JSONSchema7): E.Either<Error, unknown> => {
    return E.left(new Error('fallback error'));
  };

  it('returns a function matching AsyncPayloadGenerator signature', () => {
    const generator = createAiPayloadGenerator(fakeFallback, logger);
    expect(typeof generator).toBe('function');
  });

  it('produces a TaskEither Right with schema-compliant output via faker fallback', async () => {
    const generator = createAiPayloadGenerator(fakeFallback, logger);
    const result = await generator(simpleSchema)();

    expect(E.isRight(result)).toBe(true);
    if (E.isRight(result)) {
      expect(result.right).toEqual({ name: 'faker-generated' });
    }
  });

  it('propagates fallback errors as TaskEither Left', async () => {
    const generator = createAiPayloadGenerator(failingFallback, logger);
    const result = await generator(simpleSchema)();

    expect(E.isLeft(result)).toBe(true);
    if (E.isLeft(result)) {
      expect(result.left.message).toBe('fallback error');
    }
  });

  it('logs "AI mocker invoked" via the logger', async () => {
    const infoSpy = jest.fn();
    const spyLogger = { ...logger, info: infoSpy } as any;

    const generator = createAiPayloadGenerator(fakeFallback, spyLogger);
    await generator(simpleSchema)();

    expect(infoSpy).toHaveBeenCalledWith('AI mocker invoked');
  });
});
