import { ResourceMutex, createLimiter } from '../concurrency';

describe('ResourceMutex', () => {
  it('serializes concurrent acquire calls for the same key', async () => {
    const mutex = new ResourceMutex();
    const log: string[] = [];

    const task = async (label: string) => {
      const release = await mutex.acquire('shared');
      log.push(`${label}:start`);
      await new Promise(r => setTimeout(r, 20));
      log.push(`${label}:end`);
      release();
    };

    await Promise.all([task('A'), task('B')]);

    // Serialized: A must fully complete before B starts (or vice-versa)
    expect(log).toEqual(
      log[0] === 'A:start'
        ? ['A:start', 'A:end', 'B:start', 'B:end']
        : ['B:start', 'B:end', 'A:start', 'A:end'],
    );
  });

  it('allows concurrent access for different keys', async () => {
    const mutex = new ResourceMutex();
    const log: string[] = [];

    const task = async (key: string, label: string) => {
      const release = await mutex.acquire(key);
      log.push(`${label}:start`);
      await new Promise(r => setTimeout(r, 20));
      log.push(`${label}:end`);
      release();
    };

    await Promise.all([task('key1', 'A'), task('key2', 'B')]);

    // Parallel: both start before either ends
    const aStart = log.indexOf('A:start');
    const bStart = log.indexOf('B:start');
    const aEnd = log.indexOf('A:end');
    const bEnd = log.indexOf('B:end');

    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(bEnd);
    // Both should start before either ends (parallel)
    expect(Math.max(aStart, bStart)).toBeLessThan(Math.min(aEnd, bEnd));
  });
});

describe('createLimiter', () => {
  it('caps concurrent executions to the specified limit', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = () =>
      limit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 30));
        active--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxActive).toBe(2);
  });

  it('resolves all tasks even at concurrency 1', async () => {
    const limit = createLimiter(1);
    const results: number[] = [];

    const task = (n: number) =>
      limit(async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push(n);
        return n;
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(results).toHaveLength(3);
    expect(results).toEqual([1, 2, 3]);
  });
});
