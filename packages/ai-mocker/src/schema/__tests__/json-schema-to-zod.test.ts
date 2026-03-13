import * as z from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { convertJsonSchemaToZod } from '../json-schema-to-zod';

describe('convertJsonSchemaToZod', () => {
  it('returns z.any() as a fallback for Node 18 compatibility', () => {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const zod = convertJsonSchemaToZod(schema);
    
    // In Zod v3, z.any() accepts anything. This simulates the schema compliance
    // being punted to Ajv.
    expect(zod.parse({ name: 'test' })).toEqual({ name: 'test' });
    expect(zod.parse({ unknown: 123 })).toEqual({ unknown: 123 });
  });
});
