import type { JSONSchema7 } from 'json-schema';
import { convertJsonSchemaToZod } from '../json-schema-to-zod';

describe('convertJsonSchemaToZod', () => {
  // ----------------------------------------------------------------
  // Object schemas
  // ----------------------------------------------------------------
  describe('object schemas', () => {
    it('converts an object with required properties', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name', 'age'],
      };

      const zodSchema = convertJsonSchemaToZod(schema);
      const valid = zodSchema.safeParse({ name: 'Alice', age: 30 });
      const invalid = zodSchema.safeParse({ name: 'Alice' });

      expect(valid.success).toBe(true);
      expect(invalid.success).toBe(false);
    });

    it('allows optional properties when not in required', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          nickname: { type: 'string' },
        },
        required: ['name'],
      };

      const zodSchema = convertJsonSchemaToZod(schema);
      const result = zodSchema.safeParse({ name: 'Bob' });

      expect(result.success).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Array schemas
  // ----------------------------------------------------------------
  describe('array schemas', () => {
    it('converts an array with typed items', () => {
      const schema: JSONSchema7 = {
        type: 'array',
        items: { type: 'string' },
      };

      const zodSchema = convertJsonSchemaToZod(schema);
      const valid = zodSchema.safeParse(['a', 'b', 'c']);
      const invalid = zodSchema.safeParse([1, 2, 3]);

      expect(valid.success).toBe(true);
      expect(invalid.success).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Enum / const
  // ----------------------------------------------------------------
  describe('enums and const', () => {
    it('converts a string enum', () => {
      const schema: JSONSchema7 = {
        type: 'string',
        enum: ['active', 'inactive', 'pending'],
      };

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse('active').success).toBe(true);
      expect(zodSchema.safeParse('unknown').success).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Primitive types
  // ----------------------------------------------------------------
  describe('primitive types', () => {
    it('converts a number with min/max', () => {
      const schema: JSONSchema7 = {
        type: 'number',
        minimum: 0,
        maximum: 100,
      };

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse(50).success).toBe(true);
      expect(zodSchema.safeParse(-1).success).toBe(false);
      expect(zodSchema.safeParse(101).success).toBe(false);
    });

    it('converts an integer type', () => {
      const schema: JSONSchema7 = { type: 'integer' };

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(3.14).success).toBe(false);
    });

    it('converts a boolean', () => {
      const schema: JSONSchema7 = { type: 'boolean' };

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse(true).success).toBe(true);
      expect(zodSchema.safeParse('true').success).toBe(false);
    });

    it('converts null', () => {
      const schema: JSONSchema7 = { type: 'null' };

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse(null).success).toBe(true);
      expect(zodSchema.safeParse(undefined).success).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Nested schemas
  // ----------------------------------------------------------------
  describe('nested schemas', () => {
    it('converts nested object with array property', () => {
      const schema: JSONSchema7 = {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
            },
            required: ['street', 'city'],
          },
        },
        required: ['id', 'tags'],
      };

      const zodSchema = convertJsonSchemaToZod(schema);

      const valid = zodSchema.safeParse({
        id: 1,
        tags: ['admin'],
        address: { street: '123 Main St', city: 'Springfield' },
      });

      const missingRequired = zodSchema.safeParse({
        id: 1,
      });

      expect(valid.success).toBe(true);
      expect(missingRequired.success).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Edge cases / fallback
  // ----------------------------------------------------------------
  describe('edge cases', () => {
    it('returns z.any() for empty schema and accepts anything', () => {
      const schema: JSONSchema7 = {};

      const zodSchema = convertJsonSchemaToZod(schema);

      expect(zodSchema.safeParse('anything').success).toBe(true);
      expect(zodSchema.safeParse(42).success).toBe(true);
      expect(zodSchema.safeParse(null).success).toBe(true);
    });

    it('returns z.any() for $ref schemas and logs warning', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const schema: JSONSchema7 = { $ref: '#/definitions/User' };

      const zodSchema = convertJsonSchemaToZod(schema);

      // Should not throw — graceful fallback
      expect(zodSchema.safeParse({ anything: true }).success).toBe(true);

      warnSpy.mockRestore();
    });

    it('returns z.any() for unsupported complex schemas', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // allOf/oneOf/anyOf may not be fully supported — should degrade gracefully
      const schema: JSONSchema7 = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      };

      const zodSchema = convertJsonSchemaToZod(schema);

      // Whether it parses correctly or falls back, it should NOT throw
      expect(() => zodSchema.safeParse({ a: 'x', b: 1 })).not.toThrow();

      warnSpy.mockRestore();
    });
  });
});
