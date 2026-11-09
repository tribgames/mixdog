/*
 * components/status-line/footer-inputs.mjs — where the footer's data comes from (footer-render.mjs names what it is).
 *
 * Files the core (mixdogd) keeps in the data dir, read here without importing the core's modules:
 *   gateway-oauth-usage-cache.json  quota windows and balance of the OAuth routes
 *   provider-accounts.json          the selected account (it keys the cache entries)
 *   mixdog-config.json              `modules.gateway`, `gateway` and the route provider's windows/balance
 *   memory-cycle-state.json         the running memory cycle
 * One input is a protocol read: mixdogd does not write `gateway-usage.local.jsonl`, the file Node's gateway kept
 * the route spend and local budgets in; the requests of the usage ledger (`usage/getUsageRequests`) stand in for it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePluginData } from '../../../runtime/shared/plugin-paths.mjs';

const REFRESH_MS = 500;
const USAGE_REFRESH_MS = 5000;
const ACCOUNT_PROVIDERS = new Set([
  'openai-oauth',
  'anthropic-oauth',
  'grok-oauth',
  'muse-code-oauth',
  'command-code-oauth',
  'mimo-oauth',
  'cursor-oauth',
  'devin-oauth',
  'antigravity-oauth',
  'opencode-go-oauth',
]);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Only what the footer reads of the config: it also holds provider keys, which stay out of this process's cache.
function footerConfig(cfg, provider) {
  if (!isRecord(cfg)) return null;
  const agent = isRecord(cfg.agent) ? cfg.agent : {};
  const section = agent.agent?.providers ? agent.agent : agent;
  const entry = isRecord(section.providers?.[provider]) ? section.providers[provider] : {};
  const pick = ({ quotaWindows, usageWindows, balance, budget }) => ({ quotaWindows, usageWindows, balance, budget });
  return {
    modules: { gateway: { enabled: cfg.modules?.gateway?.enabled } },
    gateway: isRecord(cfg.gateway) ? pick(cfg.gateway) : {},
    agent: { providers: { [provider]: pick(entry) } },
  };
}

function needsUsageEvents(config, provider) {
  const kind = provider.includes('oauth') ? 'oauth' : provider === 'mixdog-local' ? 'local' : 'api';
  const entry = config?.agent?.providers?.[provider] || {};
  return (
    kind === 'api' ||
    [config?.gateway, entry].some((s) => s && (s.quotaWindows || s.usageWindows || s.balance || s.budget))
  );
}

/**
 * `readUsageRequests(options)` is the session's `getUsageRequests` (or undefined before the session exists);
 * `dataDir` and `now` default to the TUI's.
 */
export function createFooterInputs({ dataDir = resolvePluginData(), readUsageRequests = null, now = Date.now } = {}) {
  let held = { key: '', at: -Infinity, data: null };
  let usage = { key: '', at: -Infinity, rows: [] };
  let usageSource = readUsageRequests;
  let inflight = null;

  async function usageEvents(provider, model, config) {
    if (!usageSource || !provider || !needsUsageEvents(config, provider)) return [];
    const key = `${provider}\0${model}`;
    if (usage.key === key && now() - usage.at < USAGE_REFRESH_MS) return usage.rows;
    try {
      const page = await usageSource({ view: 'hour', model, limit: 500 });
      const rows = (Array.isArray(page?.requests) ? page.requests : [])
        .map((r) => ({ ts: Number(r?.ts), provider: String(r?.provider || ''), model: String(r?.model || ''), costUsd: Number(r?.costUsd) || 0 }))
        .filter((r) => Number.isFinite(r.ts));
      usage = { key, at: now(), rows };
    } catch {
      usage = { key, at: now(), rows: usage.key === key ? usage.rows : [] };
    }
    return usage.rows;
  }

  async function load(provider, model) {
    const [usageCache, accounts, cfg, memoryCycle] = await Promise.all([
      readJson(join(dataDir, 'gateway-oauth-usage-cache.json')),
      ACCOUNT_PROVIDERS.has(provider) ? readJson(join(dataDir, 'provider-accounts.json')) : null,
      readJson(join(dataDir, 'mixdog-config.json')),
      readJson(join(dataDir, 'memory-cycle-state.json')),
    ]);
    const config = footerConfig(cfg, provider);
    return {
      usageCache,
      accountId: accounts?.providers?.[provider]?.selectedId || 'default',
      config,
      memoryCycle,
      usageEvents: await usageEvents(provider, model, config),
    };
  }

  return {
    /** The session's usage-requests read, once the session exists. */
    setUsageSource(source) {
      usageSource = source;
    },
    /** The data for a route; a read of the same route within REFRESH_MS answers the held one. */
    async read(provider, model) {
      const p = String(provider || '').trim().toLowerCase();
      const m = String(model || '').trim();
      const key = `${p}\0${m}`;
      if (held.key === key && now() - held.at < REFRESH_MS) return held.data;
      inflight ??= load(p, m).finally(() => {
        inflight = null;
      });
      const data = await inflight;
      held = { key, at: now(), data };
      return data;
    },
  };
}
