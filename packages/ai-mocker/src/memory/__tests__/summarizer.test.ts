import { summarize } from '../summarizer';

describe('summarize', () => {
  it('formats a typical POST with JSON request and response', () => {
    const result = summarize(
      'POST',
      '/users',
      JSON.stringify({ name: 'Alice', age: 30 }),
      JSON.stringify({ id: 42, name: 'Alice', age: 30 }),
    );

    expect(result).toContain('[POST /users]');
    expect(result).toContain('request:');
    expect(result).toContain('name: Alice');
    expect(result).toContain('age: 30');
    expect(result).toContain('response:');
    expect(result).toContain('id: 42');
  });

  it('formats a GET with no request body', () => {
    const result = summarize('GET', '/users/42', undefined, JSON.stringify({ id: 42, name: 'Alice' }));

    expect(result).toContain('[GET /users/42]');
    expect(result).not.toContain('request:');
    expect(result).toContain('response:');
    expect(result).toContain('id: 42');
  });

  it('handles undefined response body gracefully', () => {
    const result = summarize('DELETE', '/users/42', undefined, undefined);

    expect(result).toContain('[DELETE /users/42]');
    expect(result).not.toContain('request:');
    expect(result).not.toContain('response:');
  });

  it('extracts first-level scalar values only from nested objects', () => {
    const body = JSON.stringify({
      name: 'Alice',
      address: { street: '123 Main St', city: 'Springfield' },
      active: true,
    });

    const result = summarize('POST', '/users', body, body);

    expect(result).toContain('name: Alice');
    expect(result).toContain('active: true');
    // Nested objects should be summarized, not expanded
    expect(result).not.toContain('street');
    expect(result).toContain('address: {object}');
  });

  it('summarizes arrays with element counts', () => {
    const resBody = JSON.stringify({
      items: [1, 2, 3],
      total: 3,
    });

    const result = summarize('GET', '/items', undefined, resBody);

    expect(result).toContain('items: [3 elements]');
    expect(result).toContain('total: 3');
  });

  it('handles empty objects', () => {
    const result = summarize('POST', '/noop', JSON.stringify({}), JSON.stringify({}));

    expect(result).toContain('[POST /noop]');
    // Empty objects produce no key-value pairs
    expect(result).toContain('request: {}');
    expect(result).toContain('response: {}');
  });

  it('handles non-JSON string bodies', () => {
    const result = summarize('POST', '/webhook', 'plain text body', '<html>response</html>');

    expect(result).toContain('[POST /webhook]');
    expect(result).toContain('request: plain text body');
    expect(result).toContain('response: <html>response</html>');
  });

  it('truncates output to ~1200 chars', () => {
    // Build an object with many keys to exceed 1200 chars
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      bigObj[`field_${i}`] = 'x'.repeat(20);
    }
    const body = JSON.stringify(bigObj);

    const result = summarize('POST', '/big', body, body);

    expect(result.length).toBeLessThanOrEqual(1200);
  });

  it('handles boolean and null values', () => {
    const body = JSON.stringify({ active: true, deleted: false, notes: null });

    const result = summarize('GET', '/status', undefined, body);

    expect(result).toContain('active: true');
    expect(result).toContain('deleted: false');
    expect(result).toContain('notes: null');
  });
});
