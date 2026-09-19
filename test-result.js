const { streamText, generateText } = require('ai');
const { createGroq } = require('@ai-sdk/groq');
(async () => {
  const result = streamText({
    model: createGroq({apiKey:'test'})('llama-3.1-8b-instant'),
    prompt: 'hello'
  });
  console.log(Object.keys(result));
})();
