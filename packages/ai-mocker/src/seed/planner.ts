import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Logger } from 'pino';
import type { SeedPlan } from './types';

/**
 * JSON Schema describing the SeedPlan structure for LLM structured output.
 * Used by `chatModel.withStructuredOutput()`.
 */
const SEED_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'HTTP method: GET, POST, PUT, or DELETE' },
          path: { type: 'string', description: 'API path, e.g. /users or /users/$id' },
          description: { type: 'string', description: 'Brief description of what this step does' },
          dependsOnStep: {
            type: 'integer',
            minimum: 1,
            description: '1-indexed step number whose response provides $id for this path. Omit if none.',
          },
        },
        required: ['method', 'path', 'description'],
      },
    },
  },
  required: ['steps'],
} as const;

/**
 * Build the system prompt for the planner LLM call.
 */
const buildPlannerPrompt = (
  operations: ReadonlyArray<{ readonly method: string; readonly path: string }>,
  scenariosContext?: string,
): string => {
  const opList = operations
    .map(op => `- ${op.method.toUpperCase()} ${op.path}`)
    .join('\n');

  const sections = [
    'You are a test scenario planner for an API mock server.',
    'Given the following API endpoints, generate a coherent sequence of CRUD interactions',
    'that creates a realistic starting state. Use POST to create resources first, then GET to read them.',
    'Use $id as a placeholder when a step depends on a previous step\'s generated ID.',
    '',
    '## Available Endpoints',
    opList,
  ];

  if (scenariosContext) {
    sections.push('', '## User Context', scenariosContext);
  }

  sections.push(
    '',
    '## Rules',
    '- Generate 3-8 steps for a coherent scenario',
    '- Start with POST/creation endpoints to build state',
    '- Use $id placeholders to reference IDs from prior POST responses',
    '- Set dependsOnStep to the 1-indexed step that provides the $id',
    '- Each step must use an endpoint from the Available Endpoints list',
  );

  return sections.join('\n');
};

/**
 * Seed Planner — asks the LLM to generate a coherent scenario plan
 * from the available API operations.
 */
export const planSeed = async (
  operations: ReadonlyArray<{ readonly method: string; readonly path: string }>,
  chatModel: BaseChatModel,
  logger: Logger,
  scenariosContext?: string,
): Promise<SeedPlan> => {
  const prompt = buildPlannerPrompt(operations, scenariosContext);

  logger.info({ step: 'seed_planner_start', opCount: operations.length }, 'Generating seed plan');

  const structured = chatModel.withStructuredOutput(SEED_PLAN_SCHEMA, { name: 'generate_seed_plan' });
  const result = await structured.invoke(prompt);

  const plan = result as SeedPlan;
  logger.info({ step: 'seed_planner_done', stepCount: plan.steps.length }, 'Seed plan generated');

  return plan;
};

/** Exported for testing. */
export { buildPlannerPrompt };
