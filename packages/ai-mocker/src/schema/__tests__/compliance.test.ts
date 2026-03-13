import type { JSONSchema7 } from 'json-schema';
import { validateWithAjv } from '../compliance';

describe('validateWithAjv', () => {
  // ----------------------------------------------------------------
  // Valid data
  // ----------------------------------------------------------------
  describe('valid data', () => {
    it('returns valid for conforming data', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'age'],
      };

      const result = validateWithAjv({ name: 'Alice', age: 30 }, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('accepts optional properties when absent', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name'],
      };

      const result = validateWithAjv({ name: 'Bob' }, schema);

      expect(result.valid).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Invalid data
  // ----------------------------------------------------------------
  describe('invalid data', () => {
    it('returns errors for missing required fields', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name', 'age'],
      };

      const result = validateWithAjv({ name: 'Alice' }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
      expect(result.errors!.some(e => e.includes('age'))).toBe(true);
    });

    it('returns errors for wrong types', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
      };

      const result = validateWithAjv({ count: 'not-a-number' }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // Format validation
  // ----------------------------------------------------------------
  describe('format validation', () => {
    it('validates email format', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
        },
        required: ['email'],
      };

      const valid = validateWithAjv({ email: 'alice@example.com' }, schema);
      const invalid = validateWithAjv({ email: 'not-an-email' }, schema);

      expect(valid.valid).toBe(true);
      expect(invalid.valid).toBe(false);
    });

    it('validates date-time format', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['createdAt'],
      };

      const valid = validateWithAjv({ createdAt: '2026-01-15T10:30:00Z' }, schema);
      const invalid = validateWithAjv({ createdAt: 'yesterday' }, schema);

      expect(valid.valid).toBe(true);
      expect(invalid.valid).toBe(false);
    });

    it('validates uri format', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
        },
        required: ['url'],
      };

      const valid = validateWithAjv({ url: 'https://example.com' }, schema);
      const invalid = validateWithAjv({ url: 'not a url' }, schema);

      expect(valid.valid).toBe(true);
      expect(invalid.valid).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Structured error messages
  // ----------------------------------------------------------------
  describe('error messages', () => {
    it('includes instance path in error messages', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: {
              zip: { type: 'string', pattern: '^\\d{5}$' },
            },
            required: ['zip'],
          },
        },
        required: ['address'],
      };

      const result = validateWithAjv({ address: { zip: 'abcde' } }, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some(e => e.includes('/address/zip'))).toBe(true);
    });
  });
});
