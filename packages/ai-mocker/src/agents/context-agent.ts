import type { MemoryStore } from '../memory/store';
import type { Embedder } from '../memory/embedder';
import type { summarize } from '../memory/summarizer';
import type { SearchResult, Interaction } from '../memory/types';
import type { ContextAgentInput, ContextAgentOutput, Memory, EntityState } from './types';
import { extractResourceKey, extractResourceId, extractPathParamConstraints } from './utils';

/** Dependencies injected into the context agent for testability. */
export type ContextAgentDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
};

const SEARCH_LIMIT = 5;
const SEARCH_THRESHOLD = 0.5;

/** Map a SearchResult to a Memory for downstream consumption. */
const toMemory = (result: SearchResult): Memory => ({
  summary: result.resSummary,
  body: result.resBody,
  score: result.score,
  timestamp: result.createdAt,
  operation: result.operation,
});

/** Map an Interaction to an EntityState snapshot. */
const toEntityState = (interaction: Interaction): EntityState => ({
  resourceKey: interaction.resourceKey,
  resourceId: interaction.resourceId!,
  lastBody: interaction.resBody,
  lastOperation: interaction.operation,
  timestamp: interaction.createdAt,
});

/**
 * Context Agent — retrieves relevant past interactions for the current request.
 *
 * Pipeline:
 * 1. Extract resource key and ID from the request path
 * 2. Summarize the current request for embedding
 * 3. Embed the summary into a vector
 * 4. Search the memory store for similar past interactions
 * 5. Optionally retrieve the entity snapshot for GET-by-id
 * 6. Return structured context for downstream agents
 */
export const contextAgent = async (
  input: ContextAgentInput,
  deps: ContextAgentDeps,
): Promise<ContextAgentOutput> => {
  const { request } = input;
  const { store, embedder, summarizer } = deps;

  // 1. Parse path
  const resourceKey = extractResourceKey(request.path);
  const resourceId = extractResourceId(request.path);
  const pathParamConstraints = extractPathParamConstraints(request.path, request.pathParams);

  // 2. Summarize the incoming request (no response body yet)
  const bodyStr = request.body !== undefined ? JSON.stringify(request.body) : undefined;
  const summary = summarizer(request.method, request.path, bodyStr);

  // 3. Embed
  const embedding = await embedder.embed(summary);

  // 4. Search for relevant past interactions
  const searchResults: readonly SearchResult[] = store.search(
    embedding,
    resourceKey,
    SEARCH_LIMIT,
    SEARCH_THRESHOLD,
  );

  // 5. Entity snapshot (only when we have a specific resource ID)
  const snapshot: Interaction | null =
    resourceId !== undefined ? store.getEntitySnapshot(resourceKey, resourceId) : null;

  // 6. Map to output types
  const memories: readonly Memory[] = searchResults.map(toMemory);
  const entitySnapshot: EntityState | undefined =
    snapshot !== null ? toEntityState(snapshot) : undefined;

  return {
    memories,
    entitySnapshot,
    resourceKey,
    resourceId,
    pathParamConstraints,
  };
};
