import { createHash } from 'crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JSONSchema7 } from 'json-schema';
import type { Logger } from 'pino';
import type { MemoryStore } from '../memory/store';
import type { Embedder } from '../memory/embedder';
import type { summarize } from '../memory/summarizer';
import type { HttpRequest, Intent } from './types';
import { contextAgent } from './context-agent';
import { generatorAgent } from './generator-agent';
import { memoryAgent } from './memory-agent';
import type { ResourceMutex } from '../util/concurrency';
import type { ResponseCache } from '../util/cache';
import { buildKey } from '../util/cache';
import { withTimeout, TimeoutError, EMBEDDING_TIMEOUT_MS, LLM_TIMEOUT_MS, PIPELINE_TIMEOUT_MS } from '../util/timeout';
import { timeStage, PipelineTimer } from '../util/instrumentation';

/** Dependencies injected into the orchestrator. */
export type OrchestratorDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
  readonly chatModel: BaseChatModel;
  readonly fakerFallback: (schema: JSONSchema7) => unknown;
  readonly logger: Logger;
  readonly resourceMutex: ResourceMutex;
  readonly responseCache: ResponseCache;
  readonly llmLimiter: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Optional executor for background memory persistence. When undefined, uses fire-and-forget. */
  readonly backgroundExecutor?: <T>(fn: () => Promise<T>) => void;
};

/** Classify intent from the HTTP method. */
const classifyIntent = (method: string): Intent => {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'read';
    case 'DELETE':
      return 'deletion';
    default:
      return 'mutation';
  }
};

/** Hash a JSON schema for deterministic cache key generation. */
const hashSchema = (schema: JSONSchema7): string =>
  createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 12);

/**
 * Orchestrate the full AI mock pipeline: context → generate → memory.
 *
 * Production-hardened with:
 * - **Cache**: repeated identical GETs return cached responses
 * - **Mutex**: concurrent mutations to the same resource are serialized
 * - **Timeouts**: embedding, LLM, and full pipeline each have budgets
 * - **Concurrency**: LLM calls are capped via pLimit
 * - On any timeout, falls back to faker
 */
export const orchestrate = async (
  operation: string,
  request: HttpRequest,
  schema: JSONSchema7,
  deps: OrchestratorDeps,
): Promise<unknown> => {
  const {
    store, embedder, summarizer, chatModel,
    fakerFallback, logger,
    resourceMutex, responseCache, llmLimiter,
    backgroundExecutor,
  } = deps;

  logger.info({ step: 'orchestrator_start', operation }, 'Orchestrator started');

  const schemaHash = hashSchema(schema);
  const timer = new PipelineTimer();

  const pipeline = async (): Promise<unknown> => {
    // 1. Classify intent
    const intent = classifyIntent(request.method);

    // 2. Context retrieval (with embedding timeout)
    const originalEmbed = embedder.embed.bind(embedder);
    // NOTE: fragile spread — revisit if Embedder gains internal state or this-dependent methods
    const timedEmbedder = {
      ...embedder,
      embed: async (text: string) => {
        const { result, durationMs } = await timeStage(
          'embedding',
          () => withTimeout(originalEmbed(text), EMBEDDING_TIMEOUT_MS, 'embedding'),
          logger
        );
        timer.record('embedding', durationMs);
        return result;
      },
    };

    const { result: context, durationMs: contextDuration } = await timeStage(
      'context_search',
      () => contextAgent(
        { operation, request },
        { store, embedder: timedEmbedder as Embedder, summarizer },
      ),
      logger
    );
    timer.record('context_search', contextDuration);

    // Check cache (after context, so we have memory IDs for the key)

    const memoryIds = context.memories.map(m => m.timestamp);
    const cacheKey = buildKey(operation, memoryIds, schemaHash);


    const cached = responseCache.get(cacheKey);
    if (cached !== undefined) {
      logger.info({ cacheKey }, 'Cache hit — returning cached response');
      return cached;
    }

    // 3. Acquire mutex for mutations/deletions
    const needsLock = intent === 'mutation' || intent === 'deletion';
    const release = needsLock ? await resourceMutex.acquire(context.resourceKey) : undefined;

    try {
      // 4. Generate response (with LLM concurrency + timeout)
      const generated = await llmLimiter(async () => {
        const { result, durationMs } = await timeStage(
          'llm',
          () => withTimeout(
            generatorAgent({ schema, request, context, intent }, chatModel, logger),
            LLM_TIMEOUT_MS,
            'llm',
          ),
          logger
        );
        timer.record('llm', durationMs);
        return result;
      });


      // 5. Determine final body — fall back to faker if needed
      const body =
        generated.source === 'fallback' || !generated.compliant
          ? fakerFallback(schema)
          : generated.body;

      // 6. Invalidate cache on mutations, populate on success
      if (needsLock) {
        responseCache.invalidate(context.resourceKey);
      }
      responseCache.set(cacheKey, body);

      // 7. Background memory persistence (fire-and-forget unless executor injected)
      const persistMemory = () => memoryAgent(
        {
          operation,
          request,
          response: body,
          method: request.method,
          path: request.path,
          resourceKey: context.resourceKey,
          resourceId: context.resourceId,
        },
        { store, embedder, summarizer },
        logger,
      );

      const executor = backgroundExecutor ?? (<T>(fn: () => Promise<T>) => {
        fn().catch(err => logger.error({ err }, 'Memory agent failed'));
      });

      const { durationMs: memoryDurationMs } = await timeStage('memory_enqueue', async () => {
        executor(persistMemory);
      }, logger);
      timer.record('memory_enqueue', memoryDurationMs);


      return body;
    } finally {
      release?.();
    }
  };

  // Wrap full pipeline in timeout — fall back to faker on timeout
  try {
    return await withTimeout(pipeline(), PIPELINE_TIMEOUT_MS, 'pipeline');
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn('[AI Mocker] Pipeline timeout — falling back to faker: ' + err.message);
    } else {
      logger.error('[AI Mocker] Pipeline failed — falling back to faker: ' + (err instanceof Error ? err.message : String(err)));
    }
    return fakerFallback(schema);
  } finally {
    logger.info({ pipeline: timer.summary() }, 'Pipeline timing summary');
  }
};

