import type { JSONSchema7 } from 'json-schema';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GeneratorAgentInput, ContextAgentOutput } from '../types';
import { generatorAgent, buildSystemPrompt, overlayRequestFields } from '../generator-agent';
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
      const schema = (chatModel.withStructuredOutput as jest.Mock).mock.calls[0][0];
      expect(schema).toBeDefined();
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
    });

    it('marks non-compliant LLM output as compliant: false', async () => {
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
      expect(prompt).toContain('response MUST include all fields from the request body');
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

  // ----------------------------------------------------------------
  // Mutation response overlay
  // ----------------------------------------------------------------
  describe('mutation response overlay', () => {
    const mutationSchema: JSONSchema7 = {
      type: 'object',
      properties: {
        id: { type: 'integer', readOnly: true } as JSONSchema7 & { readOnly: boolean },
        name: { type: 'string' },
        email: { type: 'string' },
        createdAt: { type: 'string', readOnly: true } as JSONSchema7 & { readOnly: boolean },
      },
      required: ['id', 'name'],
    };

    it('echoes request body fields into mutation response', async () => {
      const llmResponse = { id: 42, name: 'LLM-Generated', email: 'llm@example.com' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users', body: { name: 'Buddy', email: 'buddy@test.com' } },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      expect(result.body).toEqual({ id: 42, name: 'Buddy', email: 'buddy@test.com' });
      expect(result.compliant).toBe(true);
      expect(result.source).toBe('llm');
    });

    it('preserves server-generated fields not in request body', async () => {
      const llmResponse = { id: 99, name: 'Whatever', createdAt: '2026-01-01T00:00:00Z' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users', body: { name: 'Buddy' } },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      expect((result.body as Record<string, unknown>).id).toBe(99);
      expect((result.body as Record<string, unknown>).createdAt).toBe('2026-01-01T00:00:00Z');
      expect((result.body as Record<string, unknown>).name).toBe('Buddy');
    });

    it('does NOT overlay readOnly fields from request body', async () => {
      const llmResponse = { id: 42, name: 'LLM-Name' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'PUT', path: '/users/42', body: { id: 99, name: 'Updated' } },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      expect((result.body as Record<string, unknown>).id).toBe(42);
      expect((result.body as Record<string, unknown>).name).toBe('Updated');
    });

    it('falls back to pure LLM output when overlay breaks Ajv validation', async () => {
      const strictSchema: JSONSchema7 = {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string', minLength: 5 },
        },
        required: ['id', 'name'],
      };

      const llmResponse = { id: 1, name: 'ValidLongName' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: strictSchema,
          request: { method: 'POST', path: '/users', body: { name: 'Bo' } },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      expect(result.body).toEqual(llmResponse);
      expect(result.compliant).toBe(true);
      expect(result.source).toBe('llm');
    });

    it('does NOT apply overlay for read intent', async () => {
      const llmResponse = { id: 1, name: 'Alice' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'GET', path: '/users/1', body: { name: 'Hacker' } },
          intent: 'read',
        }),
        chatModel,
        mockLogger,
      );

      expect(result.body).toEqual(llmResponse);
    });

    it('skips overlay when request body is not an object', async () => {
      const llmResponse = { id: 1, name: 'Alice' };
      const chatModel = mockChatModel(llmResponse);

      const result1 = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users', body: [{ name: 'Arr' }] },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );
      expect(result1.body).toEqual(llmResponse);

      const result2 = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users', body: 'just a string' },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );
      expect(result2.body).toEqual(llmResponse);
    });

    it('skips overlay when request body is null or undefined', async () => {
      const llmResponse = { id: 1, name: 'Alice' };
      const chatModel = mockChatModel(llmResponse);

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users' },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      expect(result.body).toEqual(llmResponse);
    });

    it('repairs non-compliant mutation output via overlay when request has missing required fields', async () => {
      // LLM returns { id: 1 } — missing required 'name'
      const chatModel = mockChatModel({ id: 1 });

      const result = await generatorAgent(
        makeInput({
          schema: mutationSchema,
          request: { method: 'POST', path: '/users', body: { name: 'Buddy' } },
          intent: 'mutation',
        }),
        chatModel,
        mockLogger,
      );

      // Overlay should repair by adding 'name' from request body
      expect((result.body as Record<string, unknown>).name).toBe('Buddy');
      expect(result.compliant).toBe(true);
      expect(result.source).toBe('llm');
    });
  });

  // ----------------------------------------------------------------
  // overlayRequestFields (unit tests)
  // ----------------------------------------------------------------
  describe('overlayRequestFields', () => {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        id: { type: 'integer', readOnly: true } as JSONSchema7 & { readOnly: boolean },
        name: { type: 'string' },
        email: { type: 'string' },
      },
    };

    it('overlays non-readOnly fields from request body', () => {
      const result = overlayRequestFields(
        { id: 1, name: 'LLM', email: 'llm@x.com' },
        { name: 'Request', email: 'req@x.com' },
        schema,
      );
      expect(result).toEqual({ id: 1, name: 'Request', email: 'req@x.com' });
    });

    it('skips readOnly fields', () => {
      const result = overlayRequestFields({ id: 1, name: 'LLM' }, { id: 99, name: 'Req' }, schema);
      expect(result).toEqual({ id: 1, name: 'Req' });
    });

    it('returns llmOutput unchanged for non-object requestBody', () => {
      const llm = { id: 1, name: 'LLM' };
      expect(overlayRequestFields(llm, null, schema)).toBe(llm);
      expect(overlayRequestFields(llm, undefined, schema)).toBe(llm);
      expect(overlayRequestFields(llm, [1, 2], schema)).toBe(llm);
      expect(overlayRequestFields(llm, 'string', schema)).toBe(llm);
      expect(overlayRequestFields(llm, 42, schema)).toBe(llm);
    });

    it('skips fields not in schema.properties', () => {
      const result = overlayRequestFields(
        { id: 1, name: 'LLM' },
        { name: 'Req', unknownField: 'ignored' },
        schema,
      );
      expect(result).toEqual({ id: 1, name: 'Req' });
      expect((result as Record<string, unknown>).unknownField).toBeUndefined();
    });

    it('returns llmOutput unchanged when schema has no properties', () => {
      const llm = { id: 1 };
      const noPropsSchema: JSONSchema7 = { type: 'object' };
      expect(overlayRequestFields(llm, { id: 2 }, noPropsSchema)).toBe(llm);
    });

    it('returns llmOutput unchanged when llmOutput is not an object', () => {
      const reqBody = { name: 'Req' };
      expect(overlayRequestFields('a string', reqBody, schema)).toBe('a string');
      expect(overlayRequestFields(42, reqBody, schema)).toBe(42);
      expect(overlayRequestFields(null, reqBody, schema)).toBe(null);
      expect(overlayRequestFields(undefined, reqBody, schema)).toBe(undefined);
      expect(overlayRequestFields([1, 2], reqBody, schema)).toEqual([1, 2]);
    });
  });
});
