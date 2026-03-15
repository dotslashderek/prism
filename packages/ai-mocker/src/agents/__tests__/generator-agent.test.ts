import type { JSONSchema7 } from 'json-schema';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GeneratorAgentInput, ContextAgentOutput } from '../types';
import { generatorAgent, buildSystemPrompt } from '../generator-agent';
import type { Logger } from 'pino';

/** Minimal mock logger for tests. */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

/** Factory for a minimal ContextAgentOutput. */
const makeContext = (overrides: Partial<ContextAgentOutput> = {}): ContextAgentOutput => ({
  memories: [],
  resourceKey: '/users',
  pathParamConstraints: {},
  ...overrides,
});

/** Factory for a GeneratorAgentInput. */
const makeInput = (overrides: Partial<GeneratorAgentInput> = {}): GeneratorAgentInput => ({
  schema: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
    },
    required: ['id', 'name'],
  },
  request: { method: 'GET', path: '/users/1' },
  context: makeContext(),
  intent: 'read',
  ...overrides,
});

/** Create a mock BaseChatModel that returns deterministic responses. */
const mockChatModel = (response: unknown): BaseChatModel => {
  const invoke = jest.fn().mockResolvedValue(response);
  const withStructuredOutput = jest.fn().mockReturnValue({ invoke });

  return { withStructuredOutput } as unknown as BaseChatModel;
};

/** Create a mock BaseChatModel that times out. */
const mockSlowChatModel = (): BaseChatModel => {
  const invoke = jest.fn().mockReturnValue(
    new Promise(resolve => setTimeout(() => resolve({ id: 1, name: 'Late' }), 5_000)),
  );
  const withStructuredOutput = jest.fn().mockReturnValue({ invoke });

  return { withStructuredOutput } as unknown as BaseChatModel;
};

/** Create a mock BaseChatModel that throws. */
const mockFailingChatModel = (): BaseChatModel => {
  const invoke = jest.fn().mockRejectedValue(new Error('LLM exploded'));
  const withStructuredOutput = jest.fn().mockReturnValue({ invoke });

  return { withStructuredOutput } as unknown as BaseChatModel;
};

describe('generatorAgent', () => {
  // ----------------------------------------------------------------
  // Successful generation
  // ----------------------------------------------------------------
  describe('successful generation', () => {
    it('returns compliant LLM response', async () => {
      const response = { id: 1, name: 'Alice' };
      const chatModel = mockChatModel(response);

      const result = await generatorAgent(makeInput(), chatModel, mockLogger);

      expect(result.body).toEqual(response);
      expect(result.compliant).toBe(true);
      expect(result.source).toBe('llm');
    });

    it('calls withStructuredOutput with a cleaned JSON Schema', async () => {
      const chatModel = mockChatModel({ id: 1, name: 'Alice' });

      await generatorAgent(makeInput(), chatModel, mockLogger);

      expect(chatModel.withStructuredOutput).toHaveBeenCalledTimes(1);
      // First arg should be a plain JSON Schema object (cleaned for LLM consumption)
      const schema = (chatModel.withStructuredOutput as jest.Mock).mock.calls[0][0];
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    });

    it('marks non-compliant LLM output as compliant: false', async () => {
      // LLM returns data missing required field 'name'
      const chatModel = mockChatModel({ id: 1 });

      const result = await generatorAgent(makeInput(), chatModel, mockLogger);

      expect(result.source).toBe('llm');
      expect(result.compliant).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // Timeout handling
  // ----------------------------------------------------------------
  describe('slow model handling (timeout delegated to orchestrator)', () => {
    it('returns LLM result even for slow models (orchestrator handles timeout)', async () => {
      // The generator agent no longer has its own timeout — the orchestrator
      // wraps the full pipeline in withTimeout(). So a slow model that eventually
      // resolves should produce an LLM-sourced result at the generator level.
      const chatModel = mockChatModel({ id: 1, name: 'SlowButValid' });

      const result = await generatorAgent(makeInput(), chatModel, mockLogger);

      expect(result.body).toEqual({ id: 1, name: 'SlowButValid' });
      expect(result.source).toBe('llm');
    });
  });

  // ----------------------------------------------------------------
  // Error handling
  // ----------------------------------------------------------------
  describe('error handling', () => {
    it('returns fallback when LLM throws', async () => {
      const chatModel = mockFailingChatModel();

      const result = await generatorAgent(makeInput(), chatModel, mockLogger);

      expect(result.body).toBeUndefined();
      expect(result.compliant).toBe(false);
      expect(result.source).toBe('fallback');
    });
  });

  // ----------------------------------------------------------------
  // System prompt construction
  // ----------------------------------------------------------------
  describe('buildSystemPrompt', () => {
    it('includes path param constraints', () => {
      const input = makeInput({
        context: makeContext({
          pathParamConstraints: { userId: '123', postId: '456' },
        }),
      });

      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('userId=123');
      expect(prompt).toContain('postId=456');
      expect(prompt).toContain('MUST appear in the response exactly as given');
    });

    it('includes context memories', () => {
      const input = makeInput({
        context: makeContext({
          memories: [
            {
              summary: 'Created user Alice',
              body: { id: 1, name: 'Alice' },
              score: 0.92,
              timestamp: Date.now(),
              operation: 'POST /users',
            },
          ],
        }),
      });

      const prompt = buildSystemPrompt(input);

      expect(prompt).toContain('POST /users');
      expect(prompt).toContain('Created user Alice');
      expect(prompt).toContain('0.92');
    });

    it('includes intent-specific guidance for read', () => {
      const prompt = buildSystemPrompt(makeInput({ intent: 'read' }));
      expect(prompt).toContain('Return existing data consistent with prior interactions');
    });

    it('includes intent-specific guidance for mutation', () => {
      const prompt = buildSystemPrompt(makeInput({ intent: 'mutation' }));
      expect(prompt).toContain('Return the updated resource reflecting the request body changes');
    });

    it('includes intent-specific guidance for deletion', () => {
      const prompt = buildSystemPrompt(makeInput({ intent: 'deletion' }));
      expect(prompt).toContain('Return a confirmation or empty response');
    });

    it('includes request body when present', () => {
      const input = makeInput({
        request: { method: 'POST', path: '/users', body: { name: 'Bob' } },
        intent: 'mutation',
      });

      const prompt = buildSystemPrompt(input);
      expect(prompt).toContain('{"name":"Bob"}');
    });

    it('includes required fields from schema', () => {
      const prompt = buildSystemPrompt(makeInput());
      expect(prompt).toContain('Required Fields: id, name');
    });

    it('includes enum constraints from schema', () => {
      const input = makeInput({
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'inactive'] },
          },
          required: ['status'],
        },
      });

      const prompt = buildSystemPrompt(input);
      expect(prompt).toContain('status: one of [active, inactive]');
    });
  });
});
