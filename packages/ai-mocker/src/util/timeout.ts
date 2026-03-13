/** Error thrown when an operation exceeds its timeout budget. */
export class TimeoutError extends Error {
  readonly label?: string;

  constructor(ms: number, label?: string) {
    const msg = label ? `${label} timed out after ${ms}ms` : `Timed out after ${ms}ms`;
    super(msg);
    this.name = 'TimeoutError';
    this.label = label;
  }
}

/**
 * Race a promise against a timeout.
 *
 * Resolves with the promise value if it settles before `ms`, otherwise
 * rejects with a `TimeoutError`.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number, label?: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);

    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

/** Timeout budget for embedding calls (ms). */
export const EMBEDDING_TIMEOUT_MS = 500;

/** Timeout budget for LLM generation calls (ms). */
export const LLM_TIMEOUT_MS = 1500;

/** Timeout budget for the full orchestrator pipeline (ms). */
export const PIPELINE_TIMEOUT_MS = 2000;
