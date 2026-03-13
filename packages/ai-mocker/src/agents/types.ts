import type { JSONSchema7 } from 'json-schema';

/** Incoming HTTP request shape for agent processing. */
export type HttpRequest = {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly pathParams?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
};

/** A retrieved memory — a past interaction distilled for agent consumption. */
export type Memory = {
  readonly summary: string;
  readonly body: unknown;
  readonly score: number;
  readonly timestamp: number;
  readonly operation: string;
};

/** Snapshot of a specific entity's last known state. */
export type EntityState = {
  readonly resourceKey: string;
  readonly resourceId: string;
  readonly lastBody: unknown;
  readonly lastOperation: string;
  readonly timestamp: number;
};

/** Input to the context agent. */
export type ContextAgentInput = {
  readonly operation: string;
  readonly request: HttpRequest;
};

/** Output from the context agent — everything needed for downstream generation. */
export type ContextAgentOutput = {
  readonly memories: readonly Memory[];
  readonly entitySnapshot?: EntityState;
  readonly resourceKey: string;
  readonly resourceId?: string;
  readonly pathParamConstraints: Record<string, string>;
};

/** Intent derived from the HTTP method — drives generation strategy. */
export type Intent = 'read' | 'mutation' | 'deletion';

/** Input to the generator agent. */
export type GeneratorAgentInput = {
  readonly schema: JSONSchema7;
  readonly request: HttpRequest;
  readonly context: ContextAgentOutput;
  readonly intent: Intent;
};

/** Output from the generator agent. */
export type GeneratorAgentOutput = {
  readonly body: unknown;
  readonly compliant: boolean;
  readonly source: 'llm' | 'fallback';
};

