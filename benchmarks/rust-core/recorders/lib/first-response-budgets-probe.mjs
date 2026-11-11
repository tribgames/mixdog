// The first-response budgets Node's providers state, read in a process of its own: Node reads the environment variables
// (`STALL_TIMEOUT_S`, `MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS`, `MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS`,
// `MIXDOG_ANTIGRAVITY_*`) once, when its modules load, so each environment is one process.
//   node first-response-budgets-probe.mjs <tree>      (the environment is the process's own; prints the JSON)
import { importFrom } from './common.mjs';

const tree = process.argv[2];
const P = 'src/runtime/agent/orchestrator/providers/';
const { VertexAIProvider } = await importFrom(tree, `${P}vertex-ai.mjs`);
const { OpenAICompatProvider } = await importFrom(tree, `${P}openai-compat.mjs`);
const { MimoOAuthProvider } = await importFrom(tree, `${P}mimo-oauth.mjs`);
const { AntigravityOAuthProvider } = await importFrom(tree, `${P}antigravity-oauth.mjs`);
const { ANTIGRAVITY_MODELS } = await importFrom(tree, `${P}antigravity-oauth-tokens.mjs`);

const plain = (budget) => (budget === null || budget === undefined ? null : { transportMs: budget.transportMs, semanticMs: budget.semanticMs });

// Vertex AI: a Flex route only. The method reads no instance state.
const vertex = {};
for (const [name, args] of [
  ['noOptions', []], ['standard', [{ modelParameters: {} }]], ['flex', [{ modelParameters: { serviceTier: 'flex' } }]],
  ['flexUpperCase', [{ modelParameters: { serviceTier: 'FLEX' } }]], ['priority', [{ modelParameters: { serviceTier: 'priority' } }]],
  ['unknownTier', [{ modelParameters: { serviceTier: 'turbo' } }]],
]) vertex[name] = plain(VertexAIProvider.prototype.firstResponseBudget.call({}, 'gemini-3.6-flash', ...args));

// OpenAI-compatible providers: one with a chat profile of its own window (mimo) and the rest, on the shared window.
const compat = { 'mimo-oauth': plain(MimoOAuthProvider.prototype.firstResponseBudget.call({ name: 'mimo-oauth' })) };
for (const name of ['xai', 'deepseek', 'openrouter', 'command-code-oauth', 'muse-code-oauth', 'opencode-go-oauth']) {
  compat[name] = plain(OpenAICompatProvider.prototype.firstResponseBudget.call({ name, config: { chatProfile: {} } }));
}

// Antigravity: every curated model, the default (no model) and an id the catalog does not list.
const antigravity = {};
for (const model of ['', ...ANTIGRAVITY_MODELS.map((entry) => entry.id), 'not-a-listed-model']) {
  antigravity[model] = plain(AntigravityOAuthProvider.prototype.firstResponseBudget.call({}, model || undefined));
}
process.stdout.write(JSON.stringify({ vertex, compat, antigravity }));
