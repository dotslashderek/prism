import { ChatOpenAI, AzureChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatBedrockConverse } from '@langchain/aws';
import { ChatOllama } from '@langchain/ollama';
import { OllamaEmbeddings } from '@langchain/ollama';
import { HuggingFaceTransformersEmbeddings } from '@langchain/community/embeddings/huggingface_transformers';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';

/** Supported chat providers. */
export type ChatProvider = 'openai' | 'azure' | 'bedrock' | 'ollama';

/** Supported embedding providers. */
export type EmbeddingProvider = 'openai' | 'ollama' | 'local';

/** Resolved provider pair for downstream consumers. */
export type ProviderConfig = {
  readonly chatModel: BaseChatModel;
  readonly embeddingModel: Embeddings;
};

/**
 * Create a LangChain chat model based on environment configuration.
 *
 * Reads `AI_PROVIDER` (default: `openai`) and `AI_MODEL` for override.
 */
export const createChatModel = (): BaseChatModel => {
  const provider = (process.env.AI_PROVIDER ?? 'openai') as ChatProvider;
  const model = process.env.AI_MODEL;

  switch (provider) {
    case 'openai':
      return new ChatOpenAI({ model: model ?? 'gpt-4o-mini' });

    case 'azure':
      return new AzureChatOpenAI({
        azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
        azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
        azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
        azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-02-15',
        model: model ?? 'gpt-4o-mini',
      });

    case 'bedrock':
      return new ChatBedrockConverse({
        model: model ?? 'anthropic.claude-3-haiku',
        region: process.env.AWS_REGION ?? 'us-east-1',
      });

    case 'ollama':
      return new ChatOllama({
        model: model ?? 'llama3.2',
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      });

    default:
      throw new Error(`Unsupported chat AI provider: ${provider}`);
  }
};

/**
 * Create a LangChain embedding model based on environment configuration.
 *
 * Reads `EMBEDDING_PROVIDER` (default: `openai`) and `EMBEDDING_MODEL` for override.
 */
export const createEmbeddingModel = (): Embeddings => {
  const provider = (process.env.EMBEDDING_PROVIDER ?? 'openai') as EmbeddingProvider;
  const model = process.env.EMBEDDING_MODEL;

  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddings({ model: model ?? 'text-embedding-3-small' });

    case 'ollama':
      return new OllamaEmbeddings({
        model: model ?? 'nomic-embed-text',
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      });

    case 'local':
      return new HuggingFaceTransformersEmbeddings({
        model: 'Xenova/all-MiniLM-L6-v2',
      });

    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
};
