import { memoryAgent, MemoryAgentDeps } from '../memory-agent';
import type { MemoryAgentInput, HttpRequest } from '../types';

describe('memoryAgent', () => {
  const mockEmbedding = new Float32Array([0.1, 0.2, 0.3]);

  const makeDeps = (): { deps: MemoryAgentDeps; mocks: Record<string, jest.Mock> } => {
    const storeMock = jest.fn();
    const markDeletedMock = jest.fn();
    const embedMock = jest.fn().mockResolvedValue(mockEmbedding);
    const summarizerMock = jest.fn().mockImplementation(
      (method: string, path: string, reqBody?: string, resBody?: string) =>
        `[${method} ${path}]${reqBody ? ` req:${reqBody}` : ''}${resBody ? ` res:${resBody}` : ''}`,
    );

    return {
      deps: {
        store: { store: storeMock, markDeleted: markDeletedMock } as unknown as MemoryAgentDeps['store'],
        embedder: { embed: embedMock } as unknown as MemoryAgentDeps['embedder'],
        summarizer: summarizerMock as unknown as MemoryAgentDeps['summarizer'],
      },
      mocks: { store: storeMock, markDeleted: markDeletedMock, embed: embedMock, summarizer: summarizerMock },
    };
  };

  const baseRequest: HttpRequest = {
    method: 'POST',
    path: '/users',
    body: { name: 'Alice' },
  };

  const baseInput: MemoryAgentInput = {
    operation: 'POST /users',
    request: baseRequest,
    response: { id: 1, name: 'Alice' },
    method: 'POST',
    path: '/users',
    resourceKey: '/users',
  };

  it('stores an interaction after summarize + embed', async () => {
    const { deps, mocks } = makeDeps();

    await memoryAgent(baseInput, deps);

    // Summarizer called twice: once for request, once for response
    expect(mocks.summarizer).toHaveBeenCalledTimes(2);
    expect(mocks.summarizer).toHaveBeenCalledWith('POST', '/users', JSON.stringify({ name: 'Alice' }));
    expect(mocks.summarizer).toHaveBeenCalledWith('POST', '/users', undefined, JSON.stringify({ id: 1, name: 'Alice' }));

    // Embedder called with combined summaries
    expect(mocks.embed).toHaveBeenCalledTimes(1);

    // Store called with an interaction
    expect(mocks.store).toHaveBeenCalledTimes(1);
    const storedInteraction = mocks.store.mock.calls[0][0];
    expect(storedInteraction.operation).toBe('POST /users');
    expect(storedInteraction.method).toBe('POST');
    expect(storedInteraction.path).toBe('/users');
    expect(storedInteraction.resourceKey).toBe('/users');
    expect(storedInteraction.embedding).toBe(mockEmbedding);
    expect(storedInteraction.isDeletion).toBe(false);
    expect(storedInteraction.resBody).toBe(JSON.stringify({ id: 1, name: 'Alice' }));
  });

  it('calls markDeleted for DELETE method with resourceId', async () => {
    const { deps, mocks } = makeDeps();

    const deleteInput: MemoryAgentInput = {
      operation: 'DELETE /users/123',
      request: { method: 'DELETE', path: '/users/123' },
      response: {},
      method: 'DELETE',
      path: '/users/123',
      resourceKey: '/users',
      resourceId: '123',
    };

    await memoryAgent(deleteInput, deps);

    expect(mocks.store).toHaveBeenCalledTimes(1);
    const storedInteraction = mocks.store.mock.calls[0][0];
    expect(storedInteraction.isDeletion).toBe(true);

    expect(mocks.markDeleted).toHaveBeenCalledWith('/users', '123');
  });

  it('does NOT call markDeleted for DELETE without resourceId', async () => {
    const { deps, mocks } = makeDeps();

    const deleteInput: MemoryAgentInput = {
      operation: 'DELETE /users',
      request: { method: 'DELETE', path: '/users' },
      response: {},
      method: 'DELETE',
      path: '/users',
      resourceKey: '/users',
    };

    await memoryAgent(deleteInput, deps);

    expect(mocks.store).toHaveBeenCalledTimes(1);
    expect(mocks.markDeleted).not.toHaveBeenCalled();
  });

  it('swallows errors — never throws', async () => {
    const { deps } = makeDeps();
    // Make embedder throw
    (deps.embedder.embed as jest.Mock).mockRejectedValue(new Error('embed boom'));
    const loggerMock = { error: jest.fn() };

    // Should not throw
    await expect(memoryAgent(baseInput, deps, loggerMock)).resolves.toBeUndefined();
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it('swallows errors even without a logger', async () => {
    const { deps } = makeDeps();
    (deps.embedder.embed as jest.Mock).mockRejectedValue(new Error('embed boom'));

    // No logger — still should not throw
    await expect(memoryAgent(baseInput, deps)).resolves.toBeUndefined();
  });
});
