import { Mutex, MutexInterface } from 'async-mutex';

/**
 * Per-resource mutex manager.
 *
 * Lazily creates a Mutex for each unique resource key so that concurrent
 * mutations to the *same* resource are serialized while different
 * resources execute in parallel.
 */
export class ResourceMutex {
  private readonly mutexes = new Map<string, Mutex>();

  /** Acquire the mutex for `resourceKey`, creating one on first access. */
  async acquire(resourceKey: string): Promise<MutexInterface.Releaser> {
    let mutex = this.mutexes.get(resourceKey);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(resourceKey, mutex);
    }
    return mutex.acquire();
  }
}

/**
 * Minimal concurrency limiter — caps the number of in-flight async tasks.
 *
 * Equivalent to pLimit but avoids ESM-only dependency issues with Jest.
 */
export const createLimiter = (concurrency: number) => {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (queue.length > 0 && active < concurrency) {
      const resolve = queue.shift()!;
      resolve();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          active--;
          next();
        }
      };

      if (active < concurrency) {
        run();
      } else {
        queue.push(() => { run(); });
      }
    });
};

/** Global LLM concurrency limiter — caps at 5 in-flight calls. */
export const llmLimiter = createLimiter(5);
