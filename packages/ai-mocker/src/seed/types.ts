/** A single step in the seed plan. */
export type SeedStep = {
  readonly method: string;
  readonly path: string;
  readonly description: string;
  readonly dependsOnStep?: number;
};

/** The full scenario plan returned by the LLM. */
export type SeedPlan = {
  readonly steps: readonly SeedStep[];
};

/** Config bag for initializeAiMocker(). */
export type SeedConfig = {
  readonly scenariosContext?: string;
  readonly clearMemory?: boolean;
  readonly timeoutMs?: number;
};

/** Result summary from the materializer. */
export type SeedResult = {
  readonly stepsExecuted: number;
  readonly resourcesSeeded: readonly string[];
};
