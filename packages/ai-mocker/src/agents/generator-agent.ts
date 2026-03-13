import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import type { Logger } from 'pino';
import type { GeneratorAgentInput, GeneratorAgentOutput, Memory } from './types';
import { convertJsonSchemaToZod } from '../schema/json-schema-to-zod';
import { validateWithAjv } from '../schema/compliance';

/** Intent-specific generation guidance. */
const INTENT_GUIDANCE: Record<string, string> = {
  read: 'Return existing data consistent with prior interactions.',
  mutation: 'Return the updated resource reflecting the request body changes.',
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
 * Generator Agent — uses LLM to generate schema-compliant, context-aware API responses.
 *
 * Triple-layer compliance:
 * 1. `withStructuredOutput(zodSchema)` constrains generation at the model level
 * 2. Ajv validates the output against the original JSON Schema
 * 3. On failure, returns a fallback marker for the orchestrator to handle
 */
export const generatorAgent = async (
  input: GeneratorAgentInput,
  chatModel: BaseChatModel,
  logger: Logger,
): Promise<GeneratorAgentOutput> => {
  try {
    const prompt = buildSystemPrompt(input);

    const structured = chatModel.withStructuredOutput(input.schema, { name: 'generate_mock_data' });
    const body = await structured.invoke(prompt);

    const { valid, errors } = validateWithAjv(body, input.schema);
    if (!valid) {
      logger.warn({ step: 'ajv_validation', body, errors }, 'Ajv validation failed for LLM output');
    } else {
      logger.info({ step: 'llm_success' }, 'LLM generation successful and valid');
    }

    return { body, compliant: valid, source: 'llm' };
  } catch (err) {
    logger.error({ step: 'llm_error', err: String(err) }, 'LLM generation threw an error');
    return { body: undefined, compliant: false, source: 'fallback' };
  }
};
