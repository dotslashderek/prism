import { createChatModel, createEmbeddingModel } from '../config';

// Mock LangChain provider modules
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((opts: any) => ({ _type: 'ChatOpenAI', ...opts })),
  AzureChatOpenAI: jest.fn().mockImplementation((opts: any) => ({ _type: 'AzureChatOpenAI', ...opts })),
  OpenAIEmbeddings: jest.fn().mockImplementation((opts: any) => ({ _type: 'OpenAIEmbeddings', ...opts })),
  AzureOpenAIEmbeddings: jest.fn().mockImplementation((opts: any) => ({ _type: 'AzureOpenAIEmbeddings', ...opts })),
}));

const { ChatOpenAI, AzureChatOpenAI, OpenAIEmbeddings, AzureOpenAIEmbeddings } = jest.requireMock('@langchain/openai');

const clearMocks = () => {
  ChatOpenAI.mockClear();
  AzureChatOpenAI.mockClear();
  OpenAIEmbeddings.mockClear();
  AzureOpenAIEmbeddings.mockClear();
};

describe('createChatModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_URL;
    delete process.env.EMBEDDING_API_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_API_KEY;
    clearMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to OpenAI with gpt-4o-mini', () => {
    delete process.env.AI_PROVIDER;
    delete process.env.AI_MODEL;

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
    expect(ChatOpenAI).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o-mini' }));
  });

  it('uses AI_MODEL override for OpenAI', () => {
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_MODEL = 'gpt-4o';

    createChatModel();

    expect(ChatOpenAI).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-4o' }));
  });

  it('creates AzureChatOpenAI when AI_PROVIDER=azure', () => {
    process.env.AI_PROVIDER = 'azure';
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.AZURE_OPENAI_API_INSTANCE_NAME = 'test-instance';
    process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME = 'test-deploy';
    process.env.AZURE_OPENAI_API_VERSION = '2024-02-15';

    createChatModel();

    expect(AzureChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it('throws on unknown provider', () => {
    process.env.AI_PROVIDER = 'banana';

    expect(() => createChatModel()).toThrow(/unsupported.*provider/i);
  });
});

describe('createEmbeddingModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENAI_API_URL;
    delete process.env.EMBEDDING_API_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMBEDDING_API_KEY;
    clearMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('defaults to OpenAI embeddings with text-embedding-3-small', () => {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_MODEL;

    createEmbeddingModel();

    expect(OpenAIEmbeddings).toHaveBeenCalledTimes(1);
    expect(OpenAIEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-small' }),
    );
  });

  it('uses EMBEDDING_MODEL override for OpenAI', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-large';

    createEmbeddingModel();

    expect(OpenAIEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'text-embedding-3-large' }),
    );
  });

  it('throws on unknown embedding provider', () => {
    process.env.EMBEDDING_PROVIDER = 'banana';

    expect(() => createEmbeddingModel()).toThrow(/unsupported.*provider/i);
  });
});
