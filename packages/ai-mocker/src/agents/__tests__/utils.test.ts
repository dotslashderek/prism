import { extractResourceKey, extractResourceId, extractPathParamConstraints } from '../utils';

describe('extractResourceKey', () => {
  it('returns the path unchanged when no trailing ID segment', () => {
    expect(extractResourceKey('/users')).toBe('/users');
  });

  it('strips a trailing numeric ID', () => {
    expect(extractResourceKey('/users/123')).toBe('/users');
  });

  it('handles nested resource paths without trailing ID', () => {
    expect(extractResourceKey('/users/123/posts')).toBe('/users/123/posts');
  });

  it('strips trailing ID from nested paths', () => {
    expect(extractResourceKey('/users/123/posts/456')).toBe('/users/123/posts');
  });

  it('strips a trailing UUID', () => {
    expect(extractResourceKey('/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('/users');
  });

  it('returns / for root path', () => {
    expect(extractResourceKey('/')).toBe('/');
  });

  it('does not strip a single-segment numeric path (no parent)', () => {
    // A path like "/123" has no parent resource — treat as the key itself
    expect(extractResourceKey('/123')).toBe('/123');
  });
});

describe('extractResourceId', () => {
  it('returns undefined when path has no ID segment', () => {
    expect(extractResourceId('/users')).toBeUndefined();
  });

  it('returns numeric ID from simple path', () => {
    expect(extractResourceId('/users/123')).toBe('123');
  });

  it('returns the last ID from nested path', () => {
    expect(extractResourceId('/users/123/posts/456')).toBe('456');
  });

  it('returns UUID from path', () => {
    expect(extractResourceId('/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    );
  });

  it('returns undefined for root path', () => {
    expect(extractResourceId('/')).toBeUndefined();
  });

  it('returns undefined when last segment is a resource name', () => {
    expect(extractResourceId('/users/123/posts')).toBeUndefined();
  });
});

describe('extractPathParamConstraints', () => {
  it('returns the pathParams map when provided', () => {
    const params = { userId: '123', postId: '456' };
    expect(extractPathParamConstraints('/users/123/posts/456', params)).toEqual(params);
  });

  it('returns empty object when pathParams is undefined', () => {
    expect(extractPathParamConstraints('/users/123')).toEqual({});
  });

  it('returns empty object when pathParams is explicitly undefined', () => {
    expect(extractPathParamConstraints('/users', undefined)).toEqual({});
  });
});
