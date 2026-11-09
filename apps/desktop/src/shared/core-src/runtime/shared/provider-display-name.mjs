// Display names for provider ids; an unknown id displays as itself.
const PROVIDER_DISPLAY_NAMES = new Map([
  ['openai-oauth', 'OpenAI OAuth'],
  ['anthropic-oauth', 'Anthropic OAuth'],
  ['grok-oauth', 'Grok OAuth'],
  ['muse-code-oauth', 'Muse Code'],
  ['command-code-oauth', 'Command Code'],
  ['mimo-oauth', 'MiMo'],
  ['cursor-oauth', 'Cursor OAuth'],
  ['devin-oauth', 'Devin'],
  ['antigravity-oauth', 'Antigravity OAuth'],
  ['openai', 'OpenAI API'],
  ['openai-api', 'OpenAI API'],
  ['anthropic', 'Anthropic API'],
  ['anthropic-api', 'Anthropic API'],
  ['gemini', 'Gemini API'],
  ['gemini-api', 'Gemini API'],
  ['xai', 'xAI API'],
  ['xai-api', 'xAI API'],
  ['deepseek', 'DeepSeek API'],
  ['deepseek-api', 'DeepSeek API'],
  ['opencode-go-oauth', 'OpenCode Go OAuth'],
  ['openrouter', 'OpenRouter'],
  ['mixdog-local', 'Local Provider'],
  ['default', 'Default'],
]);

export const providerDisplayName = (provider) =>
  PROVIDER_DISPLAY_NAMES.get(String(provider || '').toLowerCase()) ?? (provider || 'Provider');
