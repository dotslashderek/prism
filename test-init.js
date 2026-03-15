const { createChatModel, createEmbeddingModel } = require('./packages/ai-mocker/dist/providers/config');

try {
  console.log('Testing Chat Model Init...');
  const chatModel = createChatModel();
  console.log('Chat Model Init Success');
  
  console.log('Testing Embedding Model Init...');
  const embedModel = createEmbeddingModel();
  console.log('Embedding Model Init Success');
} catch (e) {
  console.error('INIT FAILED:', e);
}
