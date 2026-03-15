import { withTimeout, TimeoutError } from '../timeout';

describe('withTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when promise exceeds timeout', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 200));
    const p = withTimeout(slow, 10);
    jest.advanceTimersByTime(11);
    await expect(p).rejects.toThrow(TimeoutError);
  });

  it('includes label in error message', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 200));
    const p = withTimeout(slow, 10, 'embedding');
    jest.advanceTimersByTime(11);

    try {
      await p;
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).message).toBe('embedding timed out after 10ms');
      expect((err as TimeoutError).label).toBe('embedding');
    }
  });

  it('propagates the original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original'));
    await expect(withTimeout(failing, 1000)).rejects.toThrow('original');
  });
});
