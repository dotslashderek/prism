import type { MemoryStore } from '../memory/store';
import type { Embedder } from '../memory/embedder';
import type { summarize } from '../memory/summarizer';
import type { Interaction } from '../memory/types';
import type { MemoryAgentInput } from './types';

/** Dependencies injected into the memory agent for testability. */
export type MemoryAgentDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
};

/**
 * Memory Agent — persists an interaction to the memory store after a response
 * has been generated. Runs fire-and-forget; errors are logged but never thrown.
 *
 * Pipeline:
 * 1. Summarize the request and response separately
 * 2. Embed the combined summary
 * 3. Build and store an Interaction record
 * 4. If DELETE with a resource ID, write a tombstone
 */
export const memoryAgent = async (
  input: MemoryAgentInput,
  deps: MemoryAgentDeps,
  logger?: { error: (...args: readonly unknown[]) => void },
): Promise<void> => {
  try {
    const { store, embedder, summarizer } = deps;
    const { operation, request, response, method, path, resourceKey, resourceId } = input;

    // 1. Summarize request and response
    const reqBodyStr = request.body !== undefined ? JSON.stringify(request.body) : undefined;
    const resBodyStr = JSON.stringify(response);
    const reqSummary = summarizer(method, path, reqBodyStr);
    const resSummary = summarizer(method, path, undefined, resBodyStr);

    // 2. Embed combined summary
    const embedding = await embedder.embed(reqSummary + ' ' + resSummary);

    // 3. Build Interaction
    const interaction: Omit<Interaction, 'id'> = {
      operation,
      method,
      path,
      resourceKey,
      resourceId,
      reqSummary,
      resSummary,
      reqBody: reqBodyStr,
      resBody: resBodyStr,
      embedding,
      isDeletion: method === 'DELETE',
      createdAt: Date.now(),
    };

    // 4. Store the interaction
    store.store(interaction);

    // 5. Tombstone for DELETEs with a specific resource
    if (method === 'DELETE' && resourceId !== undefined) {
      store.markDeleted(resourceKey, resourceId);
    }
  } catch (err) {
    // Fire-and-forget — never throw
    logger?.error({ err }, 'Memory agent failed');
  }
};
