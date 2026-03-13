import { ChatOpenAI, AzureChatOpenAI, OpenAIEmbeddings, AzureOpenAIEmbeddings } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Embeddings } from '@langchain/core/embeddings';

/** Supported chat providers. */
export type ChatProvider = 'openai' | 'azure';

/** Supported embedding providers. */
export type EmbeddingProvider = 'openai';

/** Resolved provider pair for downstream consumers. */
export type ProviderConfig = {
  readonly chatModel: BaseChatModel;
  readonly embeddingModel: Embeddings;
};

/**
 * Parses an Azure OpenAI URL to extract connection parameters.
 */
const parseAzureUrl = (urlString: string) => {
  try {
    const url = new URL(urlString);
    return {
      instanceName: url.hostname.split('.')[0],
      deploymentName: url.pathname.split('/deployments/')[1]?.split('/')[0],
      apiVersion: url.searchParams.get('api-version'),
    };
  } catch {
    return null;
  }
};

/**
 * Create a LangChain chat model based on environment configuration.
 *
 * Reads `AI_PROVIDER` (default: `openai`) and `AI_MODEL` for override.
 */
export const createChatModel = (): BaseChatModel => {
  if (process.env.OPENAI_API_URL && process.env.OPENAI_API_URL.includes('.openai.azure.com')) {
    const parsed = parseAzureUrl(process.env.OPENAI_API_URL);
    if (parsed) {
      return new AzureChatOpenAI({
        azureOpenAIApiInstanceName: parsed.instanceName,
        azureOpenAIApiKey: process.env.OPENAI_API_KEY,
        azureOpenAIApiDeploymentName: parsed.deploymentName,
        azureOpenAIApiVersion: parsed.apiVersion ?? '2024-02-15',
      });
    }
  }

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
  if (process.env.EMBEDDING_API_URL && process.env.EMBEDDING_API_URL.includes('.openai.azure.com')) {
    const parsed = parseAzureUrl(process.env.EMBEDDING_API_URL);
    if (parsed) {
      return new AzureOpenAIEmbeddings({
        azureOpenAIApiInstanceName: parsed.instanceName,
        azureOpenAIApiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY,
        azureOpenAIApiDeploymentName: parsed.deploymentName,
        azureOpenAIApiVersion: parsed.apiVersion ?? '2023-05-15',
      });
    }
  }

  const provider = (process.env.EMBEDDING_PROVIDER ?? 'openai') as EmbeddingProvider;
  const model = process.env.EMBEDDING_MODEL;

  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddings({ model: model ?? 'text-embedding-3-small' });

    default:
      throw new Error(`Unsupported embedding provider: ${provider}`);
  }
};
