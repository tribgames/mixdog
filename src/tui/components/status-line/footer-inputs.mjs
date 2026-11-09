/*
 * components/status-line/footer-inputs.mjs — where the footer's data comes from (footer-render.mjs names what it is).
 * Every input is a file the core (mixdogd) keeps, read the way Node's footer read it, without importing the
 * core's modules:
 *   gateway-oauth-usage-cache.json   quota windows and balance of the OAuth routes
 *   provider-accounts.json           the selected account (it keys the cache entries)
 *   mixdog-config.json               `modules.gateway`, `gateway`, the presets and the route provider's windows/balance
 *   gateway-session-routes.json      the route each session has pinned (read with the damaged-state recovery)
 *   gateway-usage.local.jsonl        one event per request: route spend, local budgets (`loadUsageEvents`)
 *   memory-cycle-state.json          the running memory cycle
 *   Claude-current route (only for a route that inherits it): settings.json, cc-statusline-last.json,
 *   claude-current-model.json and the anthropic-oauth roster.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readJsonStateSync, writeFileAtomicSync } from '../../../runtime/shared/atomic-file.mjs';
import { withFileLockSync } from '../../../runtime/shared/file-lock.mjs';
import { resolvePluginData } from '../../../runtime/shared/plugin-paths.mjs';

const REFRESH_MS = 500;
const CLAUDE_MAX_AGE_MS = 10 * 60 * 1000;
const LEGACY_USAGE_FILE = 'gateway-usage.local.json';
const GATEWAY_USAGE_FILE = 'gateway-usage.local.jsonl';
const LEGACY_BACKUP_SUFFIX = '.migrated.bak';
const MAX_USAGE_EVENTS = 5000;
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

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readFreshJson(file, maxAgeMs, now) {
  try {
    const st = statSync(file);
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && now - st.mtimeMs > maxAgeMs) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ── the usage events: route-meta.mjs `loadUsageEvents` ─────────────────────────────────────────────── */

function parseJsonlEvents(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object') out.push(e);
    } catch {
      // A torn append (crash mid-write) is skipped, never fatal.
    }
  }
  return out;
}

/** The reader of one data dir's event store: the legacy JSON → JSONL migration once, then an incremental view. */
function createUsageEventReader(dataDir, now) {
  const store = join(dataDir, GATEWAY_USAGE_FILE);
  const lockPath = `${store}.lock`;
  let migrated = false;
  let view = { path: null, ino: null, offset: 0, events: [] };

  // Idempotent, crash-safe legacy migration serialized by the store lock (each step is an atomic rename).
  function ensureMigrated() {
    if (migrated) return;
    const legacy = join(dirname(store), LEGACY_USAGE_FILE);
    if (existsSync(legacy)) {
      try {
        withFileLockSync(lockPath, () => {
          if (!existsSync(legacy)) return;
          if (!existsSync(store)) {
            const raw = readJson(legacy);
            const events = (Array.isArray(raw?.events) ? raw.events : []).slice(-MAX_USAGE_EVENTS);
            writeFileAtomicSync(store, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
          }
          let backup = legacy + LEGACY_BACKUP_SUFFIX;
          if (existsSync(backup)) backup = `${legacy}.${now()}${LEGACY_BACKUP_SUFFIX}`;
          renameSync(legacy, backup);
        });
      } catch {
        return; // retried on the next call; the reader falls back to whatever exists
      }
    }
    migrated = true;
  }

  // Stats the file and reads only the complete lines appended since the last call; a replaced (compacted)
  // or truncated file is reloaded in full.
  function refresh() {
    let fd;
    try {
      fd = openSync(store, 'r');
      const st = fstatSync(fd);
      if (view.path !== store || view.ino !== st.ino || st.size < view.offset) {
        view = { path: store, ino: st.ino, offset: 0, events: [] };
      }
      if (st.size > view.offset) {
        const buf = Buffer.allocUnsafe(st.size - view.offset);
        const n = readSync(fd, buf, 0, buf.length, view.offset);
        const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1;
        if (end > 0) {
          view.offset += end;
          for (const e of parseJsonlEvents(buf.toString('utf8', 0, end))) view.events.push(e);
          if (view.events.length > MAX_USAGE_EVENTS * 2) view.events = view.events.slice(-MAX_USAGE_EVENTS);
        }
      }
      return view.events;
    } catch {
      view = { path: null, ino: null, offset: 0, events: [] };
      return view.events;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  return function loadUsageEvents() {
    ensureMigrated();
    return refresh().slice(-MAX_USAGE_EVENTS);
  };
}

/* ── the config ─────────────────────────────────────────────────────────────────────────────────────── */

// What the footer reads of the config: it also holds provider keys, which stay out of this process's cache.
function footerConfig(cfg, provider) {
  if (!isRecord(cfg)) return null;
  const agent = isRecord(cfg.agent) ? cfg.agent : {};
  const section = agent.agent?.providers ? agent.agent : agent;
  const windows = ({ quotaWindows, usageWindows, balance, budget }) => ({ quotaWindows, usageWindows, balance, budget });
  const providers = {};
  if (isRecord(section.providers)) {
    for (const [name, entry] of Object.entries(section.providers)) {
      providers[name] = isRecord(entry) ? { enabled: entry.enabled } : entry;
    }
  }
  if (provider && isRecord(section.providers?.[provider])) providers[provider] = { ...providers[provider], ...windows(section.providers[provider]) };
  return {
    modules: isRecord(cfg.modules) ? { gateway: cfg.modules.gateway } : {},
    gateway: isRecord(cfg.gateway) ? cfg.gateway : {},
    agent: { presets: Array.isArray(section.presets) ? section.presets : undefined, providers },
  };
}

function needsUsageEvents(config, provider) {
  const kind = provider.includes('oauth') ? 'oauth' : provider === 'mixdog-local' ? 'local' : 'api';
  const entry = config?.agent?.providers?.[provider] || {};
  return kind === 'api' || [config?.gateway, entry].some((s) => s && (s.quotaWindows || s.usageWindows || s.balance || s.budget));
}

/**
 * The data the footer renders from. `dataDir`, `configDir` (settings.json of the Claude-current route), `env` and
 * `now` default to the TUI's.
 */
export function createFooterInputs({
  dataDir = resolvePluginData(),
  configDir = process.env.MIXDOG_CONFIG_DIR || join(homedir(), '.mixdog'),
  env = process.env,
  now = Date.now,
} = {}) {
  let held = { key: '', at: -Infinity, data: null };
  const loadUsageEvents = createUsageEventReader(dataDir, now);

  function load(provider, model) {
    const cfg = readJson(join(dataDir, 'mixdog-config.json'));
    const config = footerConfig(cfg, provider);
    const accounts = ACCOUNT_PROVIDERS.has(provider) ? readJson(join(dataDir, 'provider-accounts.json')) : null;
    // The pieces only a route that inherits the Claude-current route reads, and the settings model, load on first use.
    let claude = null;
    let roster = null;
    const gatewayFiles = {
      config,
      sessionRoutes: (() => {
        const parsed = readJsonStateSync(join(dataDir, 'gateway-session-routes.json'), { fallback: {} });
        return parsed && typeof parsed === 'object' ? parsed : {};
      })(),
      env,
      get settingsModel() {
        const settings = readJson(join(configDir, 'settings.json'));
        return typeof settings?.model === 'string' ? settings.model.trim() : '';
      },
      get claude() {
        claude ??= {
          settings: readJson(join(configDir, 'settings.json')),
          own: readFreshJson(join(dataDir, 'claude-current-model.json'), CLAUDE_MAX_AGE_MS, now()),
          last: readFreshJson(join(configDir, 'cc-statusline-last.json'), CLAUDE_MAX_AGE_MS, now()),
        };
        return claude;
      },
      get roster() {
        if (roster === null) {
          const raw = readJson(join(dataDir, 'anthropic-oauth-models.json'));
          roster = [raw?.models, raw].find(Array.isArray) ?? [];
        }
        return roster;
      },
    };
    // A provider's roster file, read on first use (Node read it on each lookup).
    const rosters = new Map();
    const rosterRows = (fileName) => {
      if (!rosters.has(fileName)) {
        const raw = readJson(join(dataDir, fileName));
        rosters.set(fileName, [raw?.models, raw].find(Array.isArray) ?? []);
      }
      return rosters.get(fileName);
    };
    return {
      rosterRows,
      usageCache: readJson(join(dataDir, 'gateway-oauth-usage-cache.json')),
      accountId: accounts?.providers?.[provider]?.selectedId || 'default',
      config,
      gatewayFiles,
      memoryCycle: readJson(join(dataDir, 'memory-cycle-state.json')),
      usageEvents: provider && needsUsageEvents(config, provider) ? loadUsageEvents() : [],
    };
  }

  return {
    /** The data for a route; a read of the same route within REFRESH_MS answers the held one. */
    async read(provider, model) {
      const p = String(provider || '').trim().toLowerCase();
      const m = String(model || '').trim();
      const key = `${p}\0${m}`;
      if (held.key === key && now() - held.at < REFRESH_MS) return held.data;
      const data = load(p, m);
      held = { key, at: now(), data };
      return data;
    },
  };
}
