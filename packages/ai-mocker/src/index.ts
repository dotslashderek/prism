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
import { ResourceMutex, ResponseCache, createLimiter } from './util';

export type { AiMockerConfig } from './config';
export { defaultAiMockerConfig } from './config';

/** Async payload generator — mirrors Prism's PayloadGenerator but returns TaskEither. */
export type AsyncPayloadGenerator = (schema: JSONSchema7) => TaskEither<Error, unknown>;

// Lazy singletons — initialized once on first call
let singletonStore: MemoryStore | null = null;
let singletonEmbedder: Embedder | null = null;
let singletonChatModel: ReturnType<typeof createChatModel> | null = null;
let singletonMutex: ResourceMutex | null = null;
let singletonCache: ResponseCache | null = null;
let singletonLimiter: ReturnType<typeof createLimiter> | null = null;

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

const getOrInitMutex = (): ResourceMutex => {
  if (singletonMutex === null) {
    singletonMutex = new ResourceMutex();
  }
  return singletonMutex;
};

const getOrInitCache = (): ResponseCache => {
  if (singletonCache === null) {
    singletonCache = new ResponseCache();
  }
  return singletonCache;
};

const getOrInitLimiter = () => {
  if (singletonLimiter === null) {
    singletonLimiter = createLimiter(5);
  }
  return singletonLimiter;
};

/**
 * Scan a JSON schema tree for `example` or `examples` values.
 * Returns an array of { path, example } tuples.
 */
const extractExamples = (schema: JSONSchema7, path = ''): Array<{ path: string; example: unknown }> => {
  const results: Array<{ path: string; example: unknown }> = [];

  if (typeof schema !== 'object' || schema === null) return results;

  if ('example' in schema && schema.example !== undefined) {
    results.push({ path, example: schema.example });
  }
  if ('examples' in schema && Array.isArray((schema as any).examples)) {
    for (const ex of (schema as any).examples) {
      results.push({ path, example: ex });
    }
  }

  // Recurse into properties
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (typeof sub === 'object') {
        results.push(...extractExamples(sub as JSONSchema7, `${path}/${key}`));
      }
    }
  }

  // Recurse into items
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    results.push(...extractExamples(schema.items as JSONSchema7, `${path}[]`));
  }

  return results;
};

/**
 * Pre-warm memory with example values from schema definitions.
 * Silently continues on any error.
 */
const preWarmMemory = async (
  schema: JSONSchema7,
  store: MemoryStore,
  embedder: Embedder,
  logger: Logger,
): Promise<void> => {
  try {
    const examples = extractExamples(schema);
    if (examples.length === 0) return;

    let stored = 0;
    for (const { path, example } of examples) {
      try {
        const resBody = typeof example === 'string' ? example : JSON.stringify(example);
        const summary = summarize('SEED', path || '/example', undefined, resBody);
        const embedding = await embedder.embed(summary);

        store.store({
          operation: `SEED ${path}`,
          method: 'SEED',
          path: path || '/example',
          resourceKey: path.split('/')[1] ?? 'default',
          reqSummary: 'Seed from spec example',
          resSummary: summary,
          resBody,
          embedding,
          isDeletion: false,
          createdAt: Date.now(),
        });
        stored++;
      } catch {
        // Skip individual failures
      }
    }

    if (stored > 0) {
      logger.info(`Pre-warmed memory with ${stored} examples from spec`);
    }
  } catch {
    // Silently continue on failure
  }
};

/**
 * Create an AI-powered payload generator.
 *
 * Lazily initializes singletons for MemoryStore, Embedder, ChatModel,
 * ResourceMutex, ResponseCache, and LLM limiter.
 * Chains the full orchestrator pipeline (context → generate → memory)
 * and falls back to the provided faker-based generator on any error.
 *
 * @param fallbackGenerator - The original faker-based generator to fall back to
 * @param logger - Pino logger instance for structured logging
 * @param specSchema - Optional top-level OpenAPI schema for pre-warming
 * @returns An async PayloadGenerator wrapping the AI pipeline in TaskEither
 */
export const createAiPayloadGenerator = (
  fallbackGenerator: (schema: JSONSchema7) => import('fp-ts/Either').Either<Error, unknown>,
  logger: Logger,
  specSchema?: JSONSchema7,
): AsyncPayloadGenerator => {
  const store = getOrInitStore();
  const embedder = getOrInitEmbedder();

  // Pre-warm memory from spec examples (fire-and-forget)
  if (specSchema) {
    preWarmMemory(specSchema, store, embedder, logger).catch(() => {});
  }

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
          store,
          embedder,
          summarizer: summarize,
          chatModel: getOrInitChatModel(),
          fakerFallback,
          logger,
          resourceMutex: getOrInitMutex(),
          responseCache: getOrInitCache(),
          llmLimiter: getOrInitLimiter(),
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
  singletonMutex = null;
  singletonCache = null;
  singletonLimiter = null;
};
