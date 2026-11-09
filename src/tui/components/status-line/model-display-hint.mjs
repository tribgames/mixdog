/*
 * components/status-line/model-display-hint.mjs — the catalog's display name of a model, for the footer's model segment.
 *
 * Node's footer asked `getModelMetadataSync(model, provider)` (runtime/shared/llm/model-catalog.mjs) for it. The
 * pricing catalogs (LiteLLM, models.dev) are in memory only once something has loaded them, which the TUI process
 * does not do for the footer, so the name came from the layers that need no catalog:
 *   - a hand-verified pricing override (5 model ids), which carries no name of its own;
 *   - the provider's cached roster file (`<provider>-models.json`, written by the core), used whole when no
 *     override described the model, so its `displayName`/`display`/`name` is the hint;
 *   - the offline seed of the Muse provider, which fills a name nothing above supplied.
 * This is that resolution over the roster files' rows (`rosterRows(fileName)` reads one file's rows).
 */
const PROVIDER_CATALOGS = Object.freeze({
  openai: { modelsDev: 'openai', sameEndpoint: true },
  'openai-oauth': { modelsDev: 'openai', sameEndpoint: false, rosterFiles: ['openai-oauth-models.json'] },
  'anthropic-oauth': { modelsDev: 'anthropic', sameEndpoint: false, rosterFiles: ['anthropic-oauth-models.json'] },
  anthropic: { modelsDev: 'anthropic', sameEndpoint: true, rosterFiles: ['anthropic-oauth-models.json'] },
  gemini: { modelsDev: 'google', sameEndpoint: true, rosterFiles: ['gemini-models.json'] },
  'vertex-ai': { modelsDev: 'google-vertex', sameEndpoint: true },
  'grok-oauth': { modelsDev: 'xai', sameEndpoint: false, rosterFiles: ['grok-oauth-models.json'] },
  'muse-code-oauth': { modelsDev: 'meta', sameEndpoint: true, rosterFiles: ['muse-code-oauth-models.json'], museSeed: true },
  'mimo-oauth': { modelsDev: 'xiaomi', sameEndpoint: false, rosterFiles: ['mimo-oauth-models.json'] },
  'antigravity-oauth': { relay: true, rosterFiles: ['antigravity-oauth-models.json'] },
  'command-code-oauth': { relay: true, rosterFiles: ['command-code-oauth-models.json'] },
  'cursor-oauth': { relay: true },
  'devin-oauth': { relay: true },
  'cursor-api': { relay: true },
  'opencode-go': { relay: true },
  'opencode-go-oauth': { modelsDev: 'opencode-go', relay: true, rosterFiles: ['opencode-go-oauth-models.json'] },
});

// The models with a hand-verified pricing override, and the LiteLLM provider each belongs to.
const PRICING_OVERRIDE_PROVIDERS = Object.freeze({
  'gemini-3-flash': 'gemini',
  'gemini-3.1-pro': 'gemini',
  'deepseek-flash': 'deepseek',
  'deepseek-v4-flash': 'deepseek',
  'deepseek-v4-pro': 'deepseek',
});
// Cursor's first-party SKUs with Cursor-billed rates.
const CURSOR_PRICED = new Set(['composer-2.5', 'grok-4.7', 'grok-4.6', 'grok-4.5', 'claude-opus-4-7']);
const RETIRED_GROK_ALIASES = Object.freeze({
  'grok-code-fast-1': 'grok-build-0.1',
  'grok-code-fast': 'grok-build-0.1',
  'grok-code-fast-1-0825': 'grok-build-0.1',
});
const ANTIGRAVITY_PRICING_ALIASES = Object.freeze({ 'claude-opus-4-6-thinking': 'claude-opus-4-6' });

const MUSE_SEED_NAMES = Object.freeze({
  'muse-spark-1.1': 'Muse Spark 1.1',
  'muse-spark-1.2': 'Muse Spark 1.2',
  'muse-spark-1.2-contributor': 'Muse Spark 1.2 (C)',
  'muse-spark-1.3': 'Muse Spark 1.3',
  'muse-spark-1.3-contributor': 'Muse Spark 1.3 (C)',
});
const SPARK_ID_RE = /^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/i;

function museSeedName(id) {
  const key = String(id || '');
  if (MUSE_SEED_NAMES[key]) return MUSE_SEED_NAMES[key];
  const match = SPARK_ID_RE.exec(key);
  if (!match) return null;
  const revision = match[3] && Number(match[3]) !== 0 ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
  return `Muse Spark ${revision}${match[4] ? ' (C)' : ''}`;
}

const catalogEntry = (provider) => {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return null;
  const entry = PROVIDER_CATALOGS[p] || {};
  return {
    provider: p,
    modelsDev: entry.modelsDev || p,
    sameEndpoint: entry.sameEndpoint !== false,
    relay: entry.relay === true,
    rosterFiles: entry.rosterFiles || [],
    museSeed: entry.museSeed === true,
  };
};

function modelAliases(id) {
  const text = String(id || '').trim();
  if (!text) return [];
  return [...new Set([text, text.replace(/-\d{4}-\d{2}-\d{2}$/, ''), text.replace(/-\d{8}$/, '')])].filter(Boolean);
}

const rowId = (row) => String(row?.id || row?.name || row?.slug || '').trim();

/** The display name the catalog gives `model` of `provider`, or '' when it gives none. */
export function catalogDisplayHint(model, provider, rosterRows) {
  const original = String(model || '').trim();
  if (!original) return '';
  const source = provider ? catalogEntry(provider) : null;
  let id = original;
  if (provider === 'grok-oauth') id = RETIRED_GROK_ALIASES[id] || id;
  else if (provider === 'antigravity-oauth') id = ANTIGRAVITY_PRICING_ALIASES[id] || id;
  const mappedProvider = source?.modelsDev || null;
  const overrideProvider = PRICING_OVERRIDE_PROVIDERS[id];
  const overridden = Boolean(overrideProvider) && (!mappedProvider || catalogEntry(overrideProvider).modelsDev === mappedProvider);
  const cursorRow = source && /^cursor-(?:oauth|api)$/.test(source.provider) && CURSOR_PRICED.has(id);
  const described = overridden || cursorRow;
  const custom = String(provider || '').startsWith('custom-');

  let cached = null;
  if (source?.rosterFiles.length) {
    const aliases = new Set(modelAliases(original));
    outer: for (const fileName of source.rosterFiles) {
      for (const row of rosterRows(fileName)) {
        const found = rowId(row);
        if (found && aliases.has(found)) {
          cached = row;
          break outer;
        }
      }
    }
  }
  const seedName = source?.museSeed ? museSeedName(original) : null;
  if (!described && !cached && !seedName) return '';
  // A custom model known only through its vendor gets the guess alone.
  if (custom && !described && !cached) return '';

  // The cached roster row is the metadata when nothing described the model before it.
  let name = !described && cached ? cached.displayName || cached.display || cached.name || null : null;
  if (!name && seedName) name = seedName;
  return String(name || '').trim();
}
