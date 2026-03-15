import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import type { Logger } from 'pino';
import type { GeneratorAgentInput, GeneratorAgentOutput, Memory } from './types';
import { validateWithAjv } from '../schema/compliance';

/** Intent-specific generation guidance. */
const INTENT_GUIDANCE: Record<string, string> = {
  read: 'Return existing data consistent with prior interactions.',
  mutation:
    'For POST/PUT requests, the response MUST include all fields from the request body ' +
    'with their exact submitted values. Add server-generated fields (id, timestamps) ' +
    'but do NOT alter client-submitted values.',
  deletion: 'Return a confirmation or empty response.',
};

/** Format context memories as numbered items for the system prompt. */
const formatMemories = (memories: readonly Memory[]): string => {
  if (memories.length === 0) return 'No prior interactions recorded.';
  return memories
    .map((m, i) => `${i + 1}. [${m.operation}] ${m.summary} (relevance: ${m.score.toFixed(2)})`)
    .join('\n');
};

/** Extract required fields from a JSON Schema. */
const extractRequiredFields = (schema: JSONSchema7): readonly string[] =>
  schema.required ?? [];

/** Extract enum values from schema properties. */
const extractEnumConstraints = (schema: JSONSchema7): readonly string[] => {
  if (!schema.properties) return [];

  return Object.entries(schema.properties).flatMap(([key, prop]: [string, JSONSchema7Definition]) => {
    if (typeof prop === 'boolean') return [];
    const enumVals = prop.enum;
    if (!enumVals) return [];
    return [`${key}: one of [${enumVals.join(', ')}]`];
  });
};

/** Format path param constraints as hard requirements. */
const formatPathConstraints = (constraints: Record<string, string>): string => {
  const entries = Object.entries(constraints);
  if (entries.length === 0) return '';

  const lines = entries.map(([k, v]) => `${k}=${v}`);
  return `The following path parameter values MUST appear in the response exactly as given: ${lines.join(', ')}`;
};

/** Build the system prompt for the generator agent. */
export const buildSystemPrompt = (input: GeneratorAgentInput): string => {
  const { schema, request, context, intent } = input;
  const requiredFields = extractRequiredFields(schema);
  const enumConstraints = extractEnumConstraints(schema);

  const sections = [
    'You are an API mock server. Generate a realistic JSON response body.',
    '',
    `HTTP Method: ${request.method}`,
    `Path: ${request.path}`,
  ];

  if (request.body !== undefined) {
    sections.push(`Request Body: ${JSON.stringify(request.body)}`);
  }

  sections.push('', '## Prior Interactions', formatMemories(context.memories));

  const pathConstraints = formatPathConstraints(context.pathParamConstraints);
  if (pathConstraints) {
    sections.push('', '## Hard Constraints', pathConstraints);
  }

  if (requiredFields.length > 0) {
    sections.push('', `## Required Fields: ${requiredFields.join(', ')}`);
  }

  if (enumConstraints.length > 0) {
    sections.push('', '## Enum Constraints', ...enumConstraints);
  }

  sections.push('', '## Target JSON Schema', JSON.stringify(schema, null, 2));

  sections.push('', `## Intent: ${intent}`, INTENT_GUIDANCE[intent] ?? '');

  return sections.join('\n');
};

/**
 * Schema-aware overlay: shallow-merges request body fields onto LLM output.
 *
 * Only overlays fields that:
 * - exist in `schema.properties`
 * - are NOT marked `readOnly: true`
 *
 * Returns `llmOutput` unchanged when requestBody is null, undefined, array, or primitive.
 */
export const overlayRequestFields = (
  llmOutput: unknown,
  requestBody: unknown,
  schema: JSONSchema7,
): unknown => {
  // Guard: requestBody must be a non-null, non-array plain object
  if (
    requestBody === null ||
    requestBody === undefined ||
    typeof requestBody !== 'object' ||
    Array.isArray(requestBody)
  ) {
    return llmOutput;
  }

  // Guard: llmOutput must also be a non-null, non-array plain object
  if (
    llmOutput === null ||
    llmOutput === undefined ||
    typeof llmOutput !== 'object' ||
    Array.isArray(llmOutput)
  ) {
    return llmOutput;
  }

  const properties = schema.properties;
  if (!properties) return llmOutput;

  const reqObj = requestBody as Record<string, unknown>;
  const llmObj = llmOutput as Record<string, unknown>;
  const merged = { ...llmObj };

  for (const [key, value] of Object.entries(reqObj)) {
    const propDef = properties[key];
    // Skip fields not in schema
    if (!propDef || typeof propDef === 'boolean') continue;
    // Skip readOnly fields
    if ((propDef as JSONSchema7 & { readOnly?: boolean }).readOnly) continue;

    merged[key] = value;
  }

  return merged;
};

/**
 * Generator Agent — uses LLM to generate schema-compliant, context-aware API responses.
 *
 * Triple-layer compliance:
 * 1. `withStructuredOutput(zodSchema)` constrains generation at the model level
 * 2. Ajv validates the output against the original JSON Schema
 * 3. On failure, returns a fallback marker for the orchestrator to handle
 */
/**
 * Clean schema for strict LLM consumption (removes OpenAPI-specific properties).
 */
const cleanForLlm = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map(cleanForLlm);
  }
  if (obj !== null && typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key !== 'xml' && key !== 'example' && key !== 'examples' && key !== 'additionalProperties') {
        cleaned[key] = cleanForLlm(value);
      }
    }
    
    // OpenAI Strict Mode requires 'properties' on objects, even if empty
    if (cleaned.type === 'object' && typeof cleaned.properties !== 'object') {
      cleaned.properties = {};
    }
    
    return cleaned;
  }
  return obj;
};

export const generatorAgent = async (
  input: GeneratorAgentInput,
  chatModel: BaseChatModel,
  logger: Logger,
): Promise<GeneratorAgentOutput> => {
  try {
    const prompt = buildSystemPrompt(input);
    const safeSchema = cleanForLlm(input.schema);

    const structured = chatModel.withStructuredOutput(safeSchema, { name: 'generate_mock_data' });
    const body = await structured.invoke(prompt);

    const { valid, errors } = validateWithAjv(body, input.schema);
    if (!valid) {
      logger.warn({ step: 'ajv_validation', body, errors }, 'Ajv validation failed for LLM output');

      // For mutations, try overlay repair — request fields may fix missing required props
      if (input.intent === 'mutation') {
        const repaired = overlayRequestFields(body, input.request.body, input.schema);
        const repairResult = validateWithAjv(repaired, input.schema);
        if (repairResult.valid) {
          logger.info({ step: 'overlay_repair' }, 'Overlay repaired non-compliant mutation output');
          return { body: repaired, compliant: true, source: 'llm' };
        }
      }

      return { body, compliant: false, source: 'llm' };
    }

    logger.info({ step: 'llm_success' }, 'LLM generation successful and valid');

    // Post-LLM overlay: echo request body fields into mutation responses
    if (input.intent === 'mutation') {
      const merged = overlayRequestFields(body, input.request.body, input.schema);
      if (merged !== body) {
        const overlayResult = validateWithAjv(merged, input.schema);
        if (overlayResult.valid) {
          logger.info({ step: 'overlay_applied' }, 'Mutation overlay applied and valid');
          return { body: merged, compliant: true, source: 'llm' };
        }
        // Overlay broke validation — fall back to pristine LLM output
        logger.warn(
          { step: 'overlay_fallback', errors: overlayResult.errors },
          'Overlay broke Ajv validation, returning pure LLM output',
        );
      }
    }

    return { body, compliant: true, source: 'llm' };
  } catch (err) {
    logger.error({ step: 'llm_error', err: String(err) }, `LLM generation threw an error: ${String(err)}`);
    return { body: undefined, compliant: false, source: 'fallback' };
  }
};
