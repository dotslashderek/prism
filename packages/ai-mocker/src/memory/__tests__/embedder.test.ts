import { Embedder } from '../embedder';
import type { Embeddings } from '@langchain/core/embeddings';

/** Create a mock LangChain Embeddings instance. */
const createMockEmbeddings = (dims = 4): jest.Mocked<Pick<Embeddings, 'embedQuery'>> => ({
  embedQuery: jest.fn().mockResolvedValue(Array.from({ length: dims }, (_, i) => i * 0.1)),
});

describe('Embedder', () => {
  it('returns a Float32Array from embed()', async () => {
    const mock = createMockEmbeddings();
    const embedder = new Embedder(mock as unknown as Embeddings);

    const result = await embedder.embed('hello world');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(4);
  });

  it('converts number[] to Float32Array with correct values', async () => {
    const mock = createMockEmbeddings();
    const embedder = new Embedder(mock as unknown as Embeddings);

    const result = await embedder.embed('test');

    expect(Array.from(result)).toEqual([0, 0.1, 0.2, 0.3].map(v => Math.fround(v)));
  });

  it('caches identical text — embedQuery called once', async () => {
    const mock = createMockEmbeddings();
    const embedder = new Embedder(mock as unknown as Embeddings);

    const r1 = await embedder.embed('same text');
    const r2 = await embedder.embed('same text');

    expect(mock.embedQuery).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('calls embedQuery again for different text', async () => {
    const mock = createMockEmbeddings();
    const embedder = new Embedder(mock as unknown as Embeddings);

    await embedder.embed('text A');
    await embedder.embed('text B');

    expect(mock.embedQuery).toHaveBeenCalledTimes(2);
    expect(mock.embedQuery).toHaveBeenCalledWith('text A');
    expect(mock.embedQuery).toHaveBeenCalledWith('text B');
  });

  it('produces output compatible with MemoryStore Float32Array fields', async () => {
    const mock = createMockEmbeddings(1536);
    const embedder = new Embedder(mock as unknown as Embeddings);

    const result = await embedder.embed('embedding for memory store');

    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1536);
  });
});
