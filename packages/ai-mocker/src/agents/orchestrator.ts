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

/** Dependencies injected into the orchestrator. */
export type OrchestratorDeps = {
  readonly store: MemoryStore;
  readonly embedder: Embedder;
  readonly summarizer: typeof summarize;
  readonly chatModel: BaseChatModel;
  readonly fakerFallback: (schema: JSONSchema7) => unknown;
  readonly logger: Logger;
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

/**
 * Orchestrate the full AI mock pipeline: context → generate → memory.
 *
 * 1. Classify the request intent from the HTTP method
 * 2. Retrieve context (past interactions, entity state) via the context agent
 * 3. Generate a response via the generator agent
 * 4. Fall back to faker if the generator fails or produces non-compliant output
 * 5. Fire-and-forget the memory agent to persist the interaction
 * 6. Return the generated body
 */
export const orchestrate = async (
  operation: string,
  request: HttpRequest,
  schema: JSONSchema7,
  deps: OrchestratorDeps,
): Promise<unknown> => {
  const { store, embedder, summarizer, chatModel, fakerFallback, logger } = deps;

  // 1. Classify intent
  const intent = classifyIntent(request.method);

  // 2. Context retrieval
  const context = await contextAgent(
    { operation, request },
    { store, embedder, summarizer },
  );

  // 3. Generate response
  const generated = await generatorAgent(
    { schema, request, context, intent },
    chatModel,
  );

  // 4. Determine final body — fall back to faker if needed
  const body =
    generated.source === 'fallback' || !generated.compliant
      ? fakerFallback(schema)
      : generated.body;

  // 5. Fire-and-forget memory persistence
  memoryAgent(
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
  ).catch(err => logger.error({ err }, 'Memory agent failed'));

  // 6. Return
  return body;
};
