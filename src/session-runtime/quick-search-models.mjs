// Static quick-pick model ids surfaced during onboarding / search setup.
// Limits are intentionally not hardcoded here: rows are hydrated from live
// provider caches and provider-scoped metadata during catalog construction.

export const ONBOARDING_VERSION = 1;

export const QUICK_SEARCH_MODELS = Object.freeze({
  'openai-oauth': [
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true },
    { id: 'gpt-5.4', display: 'GPT-5.4', latest: true },
    { id: 'gpt-5', display: 'GPT-5' },
    { id: 'gpt-4.1', display: 'GPT-4.1' },
  ],
  openai: [
    { id: 'gpt-5.5', display: 'GPT-5.5', latest: true },
    { id: 'gpt-5.4', display: 'GPT-5.4', latest: true },
    { id: 'gpt-5', display: 'GPT-5' },
    { id: 'gpt-4.1', display: 'GPT-4.1' },
    { id: 'gpt-4o', display: 'GPT-4o' },
  ],
  'grok-oauth': [
    { id: 'grok-4.3', display: 'Grok 4.3', latest: true },
    { id: 'grok-4.20', display: 'Grok 4.20' },
    { id: 'grok-4', display: 'Grok 4' },
  ],
  xai: [
    { id: 'grok-4.3', display: 'Grok 4.3', latest: true },
    { id: 'grok-4.20', display: 'Grok 4.20' },
    { id: 'grok-4', display: 'Grok 4' },
  ],
  gemini: [
    { id: 'gemini-3-pro', display: 'Gemini 3 Pro', latest: true },
    { id: 'gemini-2.5-pro', display: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', display: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.0-flash', display: 'Gemini 2.0 Flash' },
  ],
  'anthropic-oauth': [
    { id: 'claude-opus-4-8', display: 'Claude Opus 4.8', latest: true },
    { id: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6', latest: true },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' },
  ],
  anthropic: [
    { id: 'claude-opus-4-8', display: 'Claude Opus 4.8', latest: true },
    { id: 'claude-sonnet-4-6', display: 'Claude Sonnet 4.6', latest: true },
    { id: 'claude-haiku-4-5-20251001', display: 'Claude Haiku 4.5' },
  ],
});
