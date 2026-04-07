// Gemini model catalog — all models available through Build Studio
// https://ai.google.dev/gemini-api/docs/models

export default [
  // Chat
  { id: 'gemini-2.5-flash',                    owned_by: 'google', object: 'model' },
  { id: 'gemini-2.5-pro',                      owned_by: 'google', object: 'model' },
  { id: 'gemini-2.5-flash-lite',               owned_by: 'google', object: 'model' },
  { id: 'gemini-2.0-flash',                    owned_by: 'google', object: 'model' },
  { id: 'gemini-2.0-flash-001',                owned_by: 'google', object: 'model' },
  { id: 'gemini-2.0-flash-lite',               owned_by: 'google', object: 'model' },
  { id: 'gemini-2.0-flash-lite-001',           owned_by: 'google', object: 'model' },
  { id: 'gemini-3-flash-preview',              owned_by: 'google', object: 'model' },
  { id: 'gemini-3-pro-preview',                owned_by: 'google', object: 'model' },
  { id: 'gemini-3.1-pro-preview',              owned_by: 'google', object: 'model' },
  { id: 'gemini-3.1-pro-preview-customtools',  owned_by: 'google', object: 'model' },
  { id: 'gemini-3.1-flash-lite-preview',       owned_by: 'google', object: 'model' },

  // Aliases
  { id: 'gemini-flash-latest',                 owned_by: 'google', object: 'model' },
  { id: 'gemini-flash-lite-latest',            owned_by: 'google', object: 'model' },
  { id: 'gemini-pro-latest',                   owned_by: 'google', object: 'model' },

  // TTS
  { id: 'gemini-2.5-flash-preview-tts',        owned_by: 'google', object: 'model' },
  { id: 'gemini-2.5-pro-preview-tts',          owned_by: 'google', object: 'model' },

  // Image generation
  { id: 'gemini-2.5-flash-image',              owned_by: 'google', object: 'model' },
  { id: 'gemini-3-pro-image-preview',          owned_by: 'google', object: 'model' },
  { id: 'nano-banana-pro-preview',             owned_by: 'google', object: 'model' },
  { id: 'gemini-3.1-flash-image-preview',      owned_by: 'google', object: 'model' },
  { id: 'imagen-4.0-generate-001',             owned_by: 'google', object: 'model' },
  { id: 'imagen-4.0-ultra-generate-001',       owned_by: 'google', object: 'model' },
  { id: 'imagen-4.0-fast-generate-001',        owned_by: 'google', object: 'model' },

  // Video generation
  { id: 'veo-2.0-generate-001',                owned_by: 'google', object: 'model' },
  { id: 'veo-3.0-generate-001',                owned_by: 'google', object: 'model' },
  { id: 'veo-3.0-fast-generate-001',           owned_by: 'google', object: 'model' },
  { id: 'veo-3.1-generate-preview',            owned_by: 'google', object: 'model' },
  { id: 'veo-3.1-fast-generate-preview',       owned_by: 'google', object: 'model' },
  { id: 'veo-3.1-lite-generate-preview',       owned_by: 'google', object: 'model' },

  // Audio / Live
  { id: 'gemini-2.5-flash-native-audio-latest',          owned_by: 'google', object: 'model' },
  { id: 'gemini-2.5-flash-native-audio-preview-09-2025', owned_by: 'google', object: 'model' },
  { id: 'gemini-2.5-flash-native-audio-preview-12-2025', owned_by: 'google', object: 'model' },
  { id: 'gemini-3.1-flash-live-preview',                 owned_by: 'google', object: 'model' },

  // Music
  { id: 'lyria-3-clip-preview',                owned_by: 'google', object: 'model' },
  { id: 'lyria-3-pro-preview',                 owned_by: 'google', object: 'model' },
  { id: 'lyria-realtime-exp',                  owned_by: 'google', object: 'model' },

  // Gemma (open models)
  { id: 'gemma-3-1b-it',                       owned_by: 'google', object: 'model' },
  { id: 'gemma-3-4b-it',                       owned_by: 'google', object: 'model' },
  { id: 'gemma-3-12b-it',                      owned_by: 'google', object: 'model' },
  { id: 'gemma-3-27b-it',                      owned_by: 'google', object: 'model' },
  { id: 'gemma-3n-e4b-it',                     owned_by: 'google', object: 'model' },
  { id: 'gemma-3n-e2b-it',                     owned_by: 'google', object: 'model' },
  { id: 'gemma-4-26b-a4b-it',                  owned_by: 'google', object: 'model' },
  { id: 'gemma-4-31b-it',                      owned_by: 'google', object: 'model' },

  // Embeddings
  { id: 'gemini-embedding-001',                owned_by: 'google', object: 'model' },
  { id: 'gemini-embedding-2-preview',          owned_by: 'google', object: 'model' },

  // Specialized
  { id: 'gemini-2.5-computer-use-preview-10-2025', owned_by: 'google', object: 'model' },
  { id: 'gemini-robotics-er-1.5-preview',      owned_by: 'google', object: 'model' },
  { id: 'deep-research-pro-preview-12-2025',   owned_by: 'google', object: 'model' },
  { id: 'aqa',                                 owned_by: 'google', object: 'model' },
];
