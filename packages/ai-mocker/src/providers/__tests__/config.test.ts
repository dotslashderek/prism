import { createChatModel, createEmbeddingModel } from '../config';

// Mock all LangChain provider modules
jest.mock('@langchain/openai', () => ({
  ChatOpenAI: jest.fn().mockImplementation((opts: any) => ({ _type: 'ChatOpenAI', ...opts })),
  AzureChatOpenAI: jest.fn().mockImplementation((opts: any) => ({ _type: 'AzureChatOpenAI', ...opts })),
  OpenAIEmbeddings: jest.fn().mockImplementation((opts: any) => ({ _type: 'OpenAIEmbeddings', ...opts })),
}));

jest.mock('@langchain/aws', () => ({
  ChatBedrockConverse: jest.fn().mockImplementation((opts: any) => ({ _type: 'ChatBedrockConverse', ...opts })),
}));

jest.mock('@langchain/ollama', () => ({
  ChatOllama: jest.fn().mockImplementation((opts: any) => ({ _type: 'ChatOllama', ...opts })),
  OllamaEmbeddings: jest.fn().mockImplementation((opts: any) => ({ _type: 'OllamaEmbeddings', ...opts })),
}));

jest.mock('@langchain/community/embeddings/huggingface_transformers', () => ({
  HuggingFaceTransformersEmbeddings: jest
    .fn()
    .mockImplementation((opts: any) => ({ _type: 'HuggingFaceTransformersEmbeddings', ...opts })),
}));



const { ChatOpenAI, AzureChatOpenAI, OpenAIEmbeddings } = jest.requireMock('@langchain/openai');
const { ChatBedrockConverse } = jest.requireMock('@langchain/aws');
const { ChatOllama, OllamaEmbeddings } = jest.requireMock('@langchain/ollama');
const { HuggingFaceTransformersEmbeddings } = jest.requireMock(
  '@langchain/community/embeddings/huggingface_transformers',
);

const clearMocks = () => {
  ChatOpenAI.mockClear();
  AzureChatOpenAI.mockClear();
  ChatBedrockConverse.mockClear();
  ChatOllama.mockClear();
  OpenAIEmbeddings.mockClear();
  OllamaEmbeddings.mockClear();
  HuggingFaceTransformersEmbeddings.mockClear();
};

describe('createChatModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
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

  it('creates ChatBedrockConverse when AI_PROVIDER=bedrock', () => {
    process.env.AI_PROVIDER = 'bedrock';
    delete process.env.AI_MODEL;

    createChatModel();

    expect(ChatBedrockConverse).toHaveBeenCalledTimes(1);
    expect(ChatBedrockConverse).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic.claude-3-haiku' }),
    );
  });

  it('creates ChatOllama when AI_PROVIDER=ollama', () => {
    process.env.AI_PROVIDER = 'ollama';
    delete process.env.AI_MODEL;

    createChatModel();

    expect(ChatOllama).toHaveBeenCalledTimes(1);
    expect(ChatOllama).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.2' }));
  });

  it('applies AI_MODEL override for bedrock', () => {
    process.env.AI_PROVIDER = 'bedrock';
    process.env.AI_MODEL = 'anthropic.claude-3-sonnet';

    createChatModel();

    expect(ChatBedrockConverse).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic.claude-3-sonnet' }),
    );
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

  it('creates OllamaEmbeddings when EMBEDDING_PROVIDER=ollama', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    delete process.env.EMBEDDING_MODEL;

    createEmbeddingModel();

    expect(OllamaEmbeddings).toHaveBeenCalledTimes(1);
    expect(OllamaEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'nomic-embed-text' }),
    );
  });

  it('creates HuggingFaceTransformersEmbeddings when EMBEDDING_PROVIDER=local', () => {
    process.env.EMBEDDING_PROVIDER = 'local';

    createEmbeddingModel();

    expect(HuggingFaceTransformersEmbeddings).toHaveBeenCalledTimes(1);
    expect(HuggingFaceTransformersEmbeddings).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Xenova/all-MiniLM-L6-v2' }),
    );
  });

  it('throws on unknown embedding provider', () => {
    process.env.EMBEDDING_PROVIDER = 'banana';

    expect(() => createEmbeddingModel()).toThrow(/unsupported.*provider/i);
  });
});
