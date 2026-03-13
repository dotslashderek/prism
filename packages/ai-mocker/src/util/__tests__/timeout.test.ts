import { withTimeout, TimeoutError } from '../timeout';

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError when promise exceeds timeout', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 200));
    await expect(withTimeout(slow, 10)).rejects.toThrow(TimeoutError);
  });

  it('includes label in error message', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 200));

    try {
      await withTimeout(slow, 10, 'embedding');
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
