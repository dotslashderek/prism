import { TaskEither } from 'fp-ts/TaskEither';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import type { JSONSchema7 } from 'json-schema';
import { MemoryStore } from './memory/store';
import { Embedder } from './memory/embedder';
import { summarize } from './memory/summarizer';
import { createChatModel, createEmbeddingModel } from './providers/config';
import { orchestrate } from './agents/orchestrator';
import type { HttpRequest } from './agents/types';

export type { AiMockerConfig } from './config';
export { defaultAiMockerConfig } from './config';

/** Async payload generator — mirrors Prism's PayloadGenerator but returns TaskEither. */
export type AsyncPayloadGenerator = (schema: JSONSchema7) => TaskEither<Error, unknown>;

// Lazy singletons — initialized once on first call
let singletonStore: MemoryStore | null = null;
let singletonEmbedder: Embedder | null = null;
let singletonChatModel: ReturnType<typeof createChatModel> | null = null;

const getOrInitStore = (): MemoryStore => {
  if (singletonStore === null) {
    singletonStore = new MemoryStore({
      dbPath: process.env.PRISM_AI_DB_PATH ?? '.prism-memory.db',
      disableVec: true,
    });
  }
  return singletonStore;
};

const getOrInitEmbedder = (): Embedder => {
  if (singletonEmbedder === null) {
    singletonEmbedder = new Embedder(createEmbeddingModel());
  }
  return singletonEmbedder;
};

const getOrInitChatModel = () => {
  if (singletonChatModel === null) {
    singletonChatModel = createChatModel();
  }
  return singletonChatModel;
};

/**
 * Create an AI-powered payload generator.
 *
 * Lazily initializes singletons for MemoryStore, Embedder, and ChatModel.
 * Chains the full orchestrator pipeline (context → generate → memory)
 * and falls back to the provided faker-based generator on any error.
 *
 * @param fallbackGenerator - The original faker-based generator to fall back to
 * @param logger - Pino logger instance for structured logging
 * @returns An async PayloadGenerator wrapping the AI pipeline in TaskEither
 */
export const createAiPayloadGenerator = (
  fallbackGenerator: (schema: JSONSchema7) => import('fp-ts/Either').Either<Error, unknown>,
  logger: Logger,
): AsyncPayloadGenerator => {
  return (schema: JSONSchema7): TaskEither<Error, unknown> => {
    logger.info('AI mocker invoked');

    // Build a placeholder HttpRequest from schema metadata
    const operation = schema.title ?? 'unknown';
    const request: HttpRequest = {
      method: 'GET',
      path: `/${operation}`,
    };

    const fakerFallback = (s: JSONSchema7): unknown => {
      const result = fallbackGenerator(s);
      if (result._tag === 'Right') return result.right;
      throw result.left;
    };

    return TE.tryCatch(
      () =>
        orchestrate(operation, request, schema, {
          store: getOrInitStore(),
          embedder: getOrInitEmbedder(),
          summarizer: summarize,
          chatModel: getOrInitChatModel(),
          fakerFallback,
          logger,
        }),
      (err): Error => (err instanceof Error ? err : new Error(String(err))),
    );
  };
};

/** Reset singletons — exposed for testing only. */
export const _resetSingletons = (): void => {
  if (singletonStore !== null) {
    singletonStore.close();
    singletonStore = null;
  }
  singletonEmbedder = null;
  singletonChatModel = null;
};
