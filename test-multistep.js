require('dotenv').config({ path: '.env.local' });
const { streamText } = require('ai');
const { google } = require('@ai-sdk/google');
const { inventoryTools } = require('./lib/ai/tools');

(async () => {
  const result = streamText({
    model: google(process.env.PRIMARY_MODEL || 'gemini-3.6-flash'),
    system: 'You are EcomSync AI. Always use tools to fetch live data.',
    messages: [
      { role: 'user', content: 'What is the inventory for SKU-001?' }
    ],
    tools: inventoryTools,
    maxSteps: 5,
    maxTokens: 512,
  });

  for await (const chunk of result.fullStream) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
    else if (chunk.type === 'finish') console.log('\n\n[DONE] finishReason:', chunk.finishReason, 'steps:', chunk.usage?.totalSteps);
    else console.log('[chunk]', chunk.type);
  }
})();
