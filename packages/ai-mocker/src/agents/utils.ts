/**
 * Regex matching a path segment that looks like a resource identifier:
 * - Pure numeric: 123
 * - UUID v4: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Extract the base resource key from a request path by stripping a trailing ID segment.
 *
 * @example
 * extractResourceKey('/users')           // '/users'
 * extractResourceKey('/users/123')       // '/users'
 * extractResourceKey('/users/123/posts') // '/users/123/posts'
 * extractResourceKey('/users/123/posts/456') // '/users/123/posts'
 */
export const extractResourceKey = (path: string): string => {
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) return '/';

  const last = segments[segments.length - 1];

  if (ID_SEGMENT.test(last) && segments.length > 1) {
    return '/' + segments.slice(0, -1).join('/');
  }

  return '/' + segments.join('/');
};

/**
 * Extract the resource identifier (last numeric or UUID segment) from a path.
 *
 * @example
 * extractResourceId('/users')           // undefined
 * extractResourceId('/users/123')       // '123'
 * extractResourceId('/users/123/posts/456') // '456'
 */
export const extractResourceId = (path: string): string | undefined => {
  const segments = path.split('/').filter(Boolean);

  if (segments.length === 0) return undefined;

  const last = segments[segments.length - 1];

  return ID_SEGMENT.test(last) ? last : undefined;
};

/**
 * Extract path parameter constraints from explicit pathParams or return empty.
 *
 * @param _path - The request path (reserved for future pattern matching)
 * @param pathParams - Explicit path parameter map from the router
 */
export const extractPathParamConstraints = (
  _path: string,
  pathParams?: Record<string, string>,
): Record<string, string> => {
  return pathParams ?? {};
};
