// Static quick-pick model ids surfaced during onboarding / web-search setup.
// Limits are intentionally not hardcoded here: rows are hydrated from live
// provider caches and provider-scoped metadata during catalog construction.

export const ONBOARDING_VERSION = 1;

export const QUICK_WEB_SEARCH_MODELS = Object.freeze({
  'openai-oauth': [
    { id: 'gpt-5.6-sol', display: 'GPT-5.6 Sol', latest: true },
    { id: 'gpt-5.6-terra', display: 'GPT-5.6 Terra', latest: true },
    { id: 'gpt-5.6-luna', display: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true },
    { id: 'gpt-5.4-mini', display: 'GPT-5.4 Mini' },
  ],
  openai: [
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true },
    { id: 'gpt-5.4', display: 'GPT-5.4', latest: true },
    { id: 'gpt-5', display: 'GPT-5' },
    { id: 'gpt-4.1', display: 'GPT-4.1' },
    { id: 'gpt-4o', display: 'GPT-4o' },
  ],
  'grok-oauth': [
    { id: 'grok-4.5', display: 'Grok 4.5', latest: true },
  ],
  xai: [
    { id: 'grok-4.5', display: 'Grok 4.5', latest: true },
  ],
  gemini: [
    { id: 'gemini-3.6-flash', display: 'Gemini 3.6 Flash', latest: true },
    { id: 'gemini-3.5-flash-lite', display: 'Gemini 3.5 Flash Lite', latest: true },
    { id: 'gemini-3.1-pro-preview', display: 'Gemini 3.1 Pro Preview' },
  ],
  'anthropic-oauth': [
    { id: 'claude-opus-5', display: 'Claude Opus 5', latest: true },
    { id: 'claude-sonnet-5', display: 'Claude Sonnet 5', latest: true },
    { id: 'claude-fable-5', display: 'Claude Fable 5', latest: true },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' },
  ],
  anthropic: [
    { id: 'claude-opus-5', display: 'Claude Opus 5', latest: true },
    { id: 'claude-sonnet-5', display: 'Claude Sonnet 5', latest: true },
    { id: 'claude-fable-5', display: 'Claude Fable 5', latest: true },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' },
  ],
});
