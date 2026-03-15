/** Wrap an async function with timing instrumentation. */
export const timeStage = async <T>(
  stage: string,
  fn: () => Promise<T>,
  logger: { info: (...args: readonly unknown[]) => void },
): Promise<{ result: T; durationMs: number }> => {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    logger.info({ stage, durationMs }, `Pipeline stage '${stage}' completed`);
    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    logger.info({ stage, durationMs, error: true }, `Pipeline stage '${stage}' failed`);
    throw error;
  }
};

/** Accumulate per-stage timings and emit a summary. */
export class PipelineTimer {
  private timings: Record<string, number> = {};

  record(stage: string, durationMs: number): void {
    if (this.timings[stage] !== undefined) {
      this.timings[stage] += durationMs;
    } else {
      this.timings[stage] = durationMs;
    }
  }

  summary(): Record<string, number> & { total: number } {
    let total = 0;
    const result: Record<string, number> = {};
    for (const [stage, duration] of Object.entries(this.timings)) {
      result[stage] = duration;
      total += duration;
    }
    return { ...result, total };
  }
}
