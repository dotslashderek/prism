import { ResponseCache, buildKey } from '../cache';

describe('buildKey', () => {
  it('produces a deterministic key', () => {
    const key = buildKey('getUser', [3, 1, 2], 'abc123');
    expect(key).toBe('getUser:1,2,3:abc123');
  });

  it('is order-independent for memoryIds', () => {
    const a = buildKey('op', [5, 2, 9], 'hash');
    const b = buildKey('op', [9, 5, 2], 'hash');
    expect(a).toBe(b);
  });

  it('handles empty memoryIds', () => {
    const key = buildKey('op', [], 'hash');
    expect(key).toBe('op::hash');
  });
});

describe('ResponseCache', () => {
  it('round-trips get/set', () => {
    const cache = new ResponseCache();
    const body = { id: 1, name: 'Alice' };
    cache.set('key1', body);
    expect(cache.get('key1')).toEqual(body);
  });

  it('returns undefined on cache miss', () => {
    const cache = new ResponseCache();
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('invalidates entries matching resource key', () => {
    const cache = new ResponseCache();
    cache.set('/users:1,2:hash1', { a: 1 });
    cache.set('/users:3,4:hash2', { b: 2 });
    cache.set('/pets:1,2:hash1', { c: 3 });

    cache.invalidate('/users');

    expect(cache.get('/users:1,2:hash1')).toBeUndefined();
    expect(cache.get('/users:3,4:hash2')).toBeUndefined();
    expect(cache.get('/pets:1,2:hash1')).toEqual({ c: 3 });
  });

  it('respects TTL expiration', async () => {
    const cache = new ResponseCache(50); // 50ms TTL
    cache.set('key', { data: true });

    expect(cache.get('key')).toEqual({ data: true });

    await new Promise(r => setTimeout(r, 100));

    expect(cache.get('key')).toBeUndefined();
  });
});
