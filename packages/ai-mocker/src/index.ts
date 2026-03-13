import { TaskEither } from 'fp-ts/TaskEither';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import type { JSONSchema7 } from 'json-schema';

export type { AiMockerConfig } from './config';
export { defaultAiMockerConfig } from './config';

/** Async payload generator — mirrors Prism's PayloadGenerator but returns TaskEither. */
export type AsyncPayloadGenerator = (schema: JSONSchema7) => TaskEither<Error, unknown>;

/**
 * Create an AI-powered payload generator.
 *
 * Currently a stub that logs "AI mocker invoked" and falls back to the
 * provided sync generator (faker-based). In M2 this will wrap real LLM
 * calls via TE.tryCatch.
 *
 * @param fallbackGenerator - The original faker-based generator to fall back to
 * @param logger - Pino logger instance for structured logging
 * @returns An async PayloadGenerator wrapping the fallback in TaskEither
 */
export const createAiPayloadGenerator = (
  fallbackGenerator: (schema: JSONSchema7) => import('fp-ts/Either').Either<Error, unknown>,
  logger: Logger,
): AsyncPayloadGenerator => {
  return (schema: JSONSchema7): TaskEither<Error, unknown> => {
    logger.info('AI mocker invoked');

    // M2: Replace this with TE.tryCatch(() => callLlm(schema), toError)
    return TE.fromEither(fallbackGenerator(schema));
  };
};
