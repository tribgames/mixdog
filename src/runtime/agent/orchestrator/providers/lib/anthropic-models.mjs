// Offline fallback for both Anthropic routes when /v1/models is unavailable:
// the current generation only, one id per family.
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', family: 'opus', contextWindow: 1000000 },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', provider: 'anthropic', family: 'fable', contextWindow: 1000000 },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    provider: 'anthropic',
    family: 'sonnet',
    contextWindow: 1000000,
  },
];
export const ANTHROPIC_VERSION = '2023-06-01';
