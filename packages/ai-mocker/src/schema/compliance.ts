import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { JSONSchema7 } from 'json-schema';

/** Result of an Ajv validation check. */
export type ValidationResult = {
  readonly valid: boolean;
  readonly errors?: readonly string[];
};

/** Shared Ajv instance with format support pre-configured. */
const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

/**
 * Validate a candidate value against a JSON Schema using Ajv.
 *
 * Returns a structured result with human-readable error messages when
 * validation fails. Uses `ajv-formats` for format keywords like
 * `email`, `date-time`, `uri`, etc.
 */
export const validateWithAjv = (candidate: unknown, schema: JSONSchema7): ValidationResult => {
  const validate = ajv.compile(schema);
  const valid = validate(candidate) as boolean;

  if (valid) {
    return { valid: true };
  }

  const errors = (validate.errors ?? []).map(
    err => `${err.instancePath || '/'} ${err.message ?? 'unknown error'}`,
  );

  return { valid: false, errors };
};
