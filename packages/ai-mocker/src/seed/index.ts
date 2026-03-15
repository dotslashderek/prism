import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Logger } from 'pino';
import type { MemoryStore } from '../memory/store';
import type { Embedder } from '../memory/embedder';
import type { summarize } from '../memory/summarizer';
import type { SeedConfig, SeedResult } from './types';
import { planSeed } from './planner';
import { materializeSeed } from './materializer';
import { withTimeout } from '../util/timeout';

const DEFAULT_SEED_TIMEOUT_MS = 60_000;

export type SeedDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
  readonly chatModel: BaseChatModel;
  readonly logger: Logger;
};

/**
 * Initialize the AI mocker by seeding the memory store with coherent scenario data.
 *
 * Orchestration flow:
 * 1. If clearMemory → wipe the store
 * 2. If store already has interactions → log skip warning, return early
 * 3. Plan → generate a coherent SeedPlan via LLM
 * 4. Materialize → persist each step with backdated timestamps
 * 5. Wrap in timeout to prevent infinite hang on startup
 */
export const initializeAiMocker = async (
  operations: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly responses?: ReadonlyArray<{
      readonly code: string;
      readonly contents?: ReadonlyArray<{ readonly schema?: unknown }>;
    }>;
  }>,
  deps: SeedDeps,
  config: SeedConfig = {},
): Promise<SeedResult | null> => {
  const { store, embedder, summarizer, chatModel, logger } = deps;
  const timeoutMs = config.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;

  // 1. Clear memory if requested
  if (config.clearMemory) {
    logger.info({ step: 'seed_clear' }, 'Clearing existing memory before seeding');
    store.clearMemory();
  }

  // 2. Idempotency check
  if (store.hasInteractions()) {
    logger.warn(
      { step: 'seed_skip' },
      'Skipping AI scenario seeding because the database already contains interactions. ' +
        'To start from scratch and re-seed, run with the --clear-memory flag.',
    );
    return null;
  }

  logger.info({ step: 'seed_start' }, 'Starting AI scenario seeding...');

  // 3-4. Plan → Materialize (wrapped in timeout)
  const seedPipeline = async (): Promise<SeedResult> => {
    const plan = await planSeed(operations, chatModel, logger, config.scenariosContext);
    return materializeSeed(plan, operations, { store, embedder, summarizer, chatModel, logger });
  };

  try {
    const result = await withTimeout(seedPipeline(), timeoutMs, 'seed');
    logger.info(
      { step: 'seed_done', ...result },
      `AI seeding complete: ${result.stepsExecuted} steps, ${result.resourcesSeeded.length} resources`,
    );
    return result;
  } catch (err) {
    logger.error(
      { step: 'seed_error', err: String(err) },
      'AI seeding failed — server will start with empty state',
    );
    return null;
  }
};
