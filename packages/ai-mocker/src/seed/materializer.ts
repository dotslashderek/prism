import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JSONSchema7 } from 'json-schema';
import type { Logger } from 'pino';
import type { MemoryStore } from '../memory/store';
import type { Embedder } from '../memory/embedder';
import type { summarize } from '../memory/summarizer';
import type { SeedPlan, SeedResult } from './types';
import { generatorAgent } from '../agents/generator-agent';
import { extractResourceKey, extractResourceId } from '../agents/utils';

/** Backdating range: spread seed interactions over the last 24 hours. */
const BACKDATE_RANGE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve $id placeholders in a path using responses from prior steps.
 */
const resolvePlaceholders = (
  path: string,
  dependsOnStep: number | undefined,
  stepResponses: ReadonlyArray<unknown>,
): string => {
  if (dependsOnStep === undefined || dependsOnStep < 1 || dependsOnStep > stepResponses.length) {
    return path;
  }

  const priorResponse = stepResponses[dependsOnStep - 1];
  if (priorResponse && typeof priorResponse === 'object' && 'id' in priorResponse) {
    return path.replace('$id', String((priorResponse as { id: unknown }).id));
  }

  return path;
};

/**
 * Find the best matching operation schema for a given method + resolved path.
 */
const findOperationSchema = (
  method: string,
  path: string,
  operations: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly responses?: ReadonlyArray<{ readonly code: string; readonly contents?: ReadonlyArray<{ readonly schema?: unknown }> }>;
  }>,
): JSONSchema7 => {
  // Normalize the path for matching — strip concrete IDs for template paths
  const normalizedPath = path.replace(/\/\d+/g, '/{id}');

  const match = operations.find(op =>
    op.method.toUpperCase() === method.toUpperCase() &&
    (op.path === path || op.path === normalizedPath || op.path.replace(/\{[^}]+\}/g, '{id}') === normalizedPath)
  );

  if (match?.responses) {
    const successResponse = match.responses.find(r => r.code.startsWith('2'));
    const schema = successResponse?.contents?.[0]?.schema;
    if (schema && typeof schema === 'object') {
      return schema as JSONSchema7;
    }
  }

  // Fallback: minimal object schema
  return { type: 'object', properties: {} };
};

/**
 * Compute a backdated timestamp for a given step.
 * Spreads steps evenly over the last 24 hours so seed data ranks lower via recency decay.
 */
const computeBackdatedTimestamp = (stepIndex: number, totalSteps: number): number => {
  const now = Date.now();
  const interval = BACKDATE_RANGE_MS / Math.max(totalSteps, 1);
  return now - BACKDATE_RANGE_MS + stepIndex * interval;
};

export type MaterializerDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
  readonly chatModel: BaseChatModel;
  readonly logger: Logger;
};

/**
 * Seed Materializer — walks through a SeedPlan, generating schema-compliant
 * responses and persisting them to the memory store with backdated timestamps.
 */
export const materializeSeed = async (
  plan: SeedPlan,
  operations: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly responses?: ReadonlyArray<{ readonly code: string; readonly contents?: ReadonlyArray<{ readonly schema?: unknown }> }>;
  }>,
  deps: MaterializerDeps,
): Promise<SeedResult> => {
  const { store, embedder, summarizer, chatModel, logger } = deps;
  const stepResponses: unknown[] = [];
  const resourcesSeeded = new Set<string>();
  let stepsExecuted = 0;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const method = step.method.toUpperCase();
    const resolvedPath = resolvePlaceholders(step.path, step.dependsOnStep, stepResponses);

    // Skip step if unresolved $-prefixed placeholders remain in the path
    if (resolvedPath.includes('$')) {
      logger.warn(
        { step: 'seed_unresolved_placeholder', path: resolvedPath, original: step.path },
        `Skipping seed step ${i + 1} — unresolved placeholder in path: ${resolvedPath}`,
      );
      stepResponses.push(undefined);
      continue;
    }

    const schema = findOperationSchema(method, resolvedPath, operations);
    const resourceKey = extractResourceKey(resolvedPath);

    logger.info(
      { step: 'seed_materialize', index: i, method, path: resolvedPath },
      `Materializing step ${i + 1}/${plan.steps.length}: ${step.description}`,
    );

    try {
      // Generate a response body using the generator agent
      const generated = await generatorAgent(
        {
          schema,
          request: { method, path: resolvedPath },
          context: {
            memories: [],
            resourceKey,
            pathParamConstraints: {},
          },
          intent: method === 'GET' ? 'read' : method === 'DELETE' ? 'deletion' : 'mutation',
        },
        chatModel,
        logger,
      );

      const body = generated.source === 'fallback' ? {} : generated.body;
      stepResponses.push(body);

      // Persist directly via store for backdated timestamps
      const backdatedTimestamp = computeBackdatedTimestamp(i, plan.steps.length);
      const resourceId = extractResourceId(resolvedPath);
      const operation = `${method} ${resolvedPath}`;
      const reqSummary = summarizer(method, resolvedPath);
      const resBody = JSON.stringify(body);
      const resSummary = summarizer(method, resolvedPath, undefined, resBody);
      const embedding = await embedder.embed(reqSummary + ' ' + resSummary);

      store.store({
        operation,
        method,
        path: resolvedPath,
        resourceKey,
        resourceId,
        reqSummary,
        resSummary,
        resBody,
        embedding,
        isDeletion: method === 'DELETE',
        createdAt: backdatedTimestamp,
      });

      resourcesSeeded.add(resourceKey);
      stepsExecuted++;
    } catch (err) {
      logger.warn(
        { step: 'seed_materialize_error', index: i, err: String(err) },
        `Seed step ${i + 1} failed, skipping`,
      );
      stepResponses.push(undefined);
    }
  }

  return {
    stepsExecuted,
    resourcesSeeded: Array.from(resourcesSeeded),
  };
};

/** Exported for testing. */
export { resolvePlaceholders, computeBackdatedTimestamp, findOperationSchema };
