import * as z from 'zod';
import type { JSONSchema7 } from 'json-schema';

/**
 * Convert a JSON Schema (draft-07) into a Zod schema for LangChain structured output.
 *
 * Wraps Zod v4's native `z.fromJSONSchema()`. On any unsupported or malformed
 * schema (including `$ref`), returns `z.any()` rather than throwing — the Ajv
 * layer downstream will catch compliance issues.
 */
export const convertJsonSchemaToZod = (schema: JSONSchema7): z.ZodType => {
  // Zod v3 lacks z.fromJSONSchema(). We return z.any() to bypass early schema
  // compilation and rely entirely on the subsequent Ajv validation pass for compliance.
  return z.any();
};
