// Where a user-made definition lives once bots have their own store (1.3.1):
// bots under <dataDir>/bots/<id>/ (with their own model route in agent.json),
// workflow agents under <dataDir>/agents/<id>/. The store is active once the
// one-time split finished (bots/migration.json, bot-split-migration.mjs);
// before that — or if it never could run — every reader sees agents/ as
// before. The ids the split copied are bots for good: their agents/ originals
// stay on disk for rollback but no catalog reads them again.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStateSync, writeJsonAtomicSync } from './atomic-file.mjs';
import { createWatchedFileCache } from './watched-file-cache.mjs';
import { setBotRouteResolver } from './agent-route-config.mjs';

export const BOTS_DIR = 'bots';
export const BOT_MIGRATION_MANIFEST = 'migration.json';
export const BOT_MIGRATION_VERSION = 1;
/** Mixy's bot id once it has its own folder. */
export const MIXY_BOT_ID = 'mixy';

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('not a JSON object');
  return value;
}

// A damaged file (NUL, truncated, not an object) is kept aside and its last
// good copy (agent.json.bak, left by writeBotRoute) restored; otherwise it
// stays in place — the connector policy reader treats a missing agent.json as
// "every connector on" — and reads as absent. Any read failure reads as absent.
const JSON_STATE = { validate: requireObject, keepWithoutBackup: true };
function readJson(file) {
  try {
    return readJsonStateSync(file, JSON_STATE);
  } catch {
    return null;
  }
}

// The store is read on route and catalog paths: warm reads come from memory
// (watched-file-cache.mjs), re-read once the file changed. A missing or
// damaged file reads as absent; any other failure throws, so the cache keeps
// what it had. The re-read is one synchronous read (no `loadAsync`): this
// process replaces these files synchronously (route writes, the agent
// editor, the bot split), and an async read's handle left open across loop
// turns would fail that rename on Windows while its retries block the loop.
const fileCache = createWatchedFileCache({
  load(file) {
    try {
      return { value: readJsonStateSync(file, JSON_STATE) };
    } catch (error) {
      if (error?.code === 'ENOTDIR') return { value: null };
      throw error;
    }
  },
});
/** For this process's writers that bypass this module (the bot-store
 *  migrations): what they rewrote under bots/ reads fresh at once. */
export function forgetBotStoreCache(dataDir) {
  if (dataDir) fileCache.deleteUnder(join(dataDir, BOTS_DIR));
}

// `fresh`: the disk now, for a read a write will be based on.
function cachedJson(file, { fresh = false } = {}) {
  try {
    return fileCache.get(file, { fresh });
  } catch {
    return null;
  }
}

/** The finished split's record, or null before it ran. */
export function readBotMigration(dataDir) {
  if (!dataDir) return null;
  const manifest = cachedJson(join(dataDir, BOTS_DIR, BOT_MIGRATION_MANIFEST));
  return manifest?.version === BOT_MIGRATION_VERSION ? manifest : null;
}

/** Whether `dataDir` has its bot store (the split finished). */
export function botStoreActive(dataDir) {
  return readBotMigration(dataDir) !== null;
}

/** The agents/ ids the split copied to bots/: the agent catalog skips them. */
export function migratedBotIds(dataDir) {
  return new Set(readBotMigration(dataDir)?.bots || []);
}

export const botDir = (dataDir, id) => join(dataDir, BOTS_DIR, id);

/** Whether `id` is a store bot: the store is active and the bot has its
 *  folder, or the split copied it (an id it moved is never an agent again).
 *  Mixy's own folder is no ordinary bot. */
export function isStoreBot(dataDir, id) {
  if (!dataDir || !id || id === MIXY_BOT_ID || id.startsWith('.')) return false;
  const manifest = readBotMigration(dataDir);
  if (!manifest) return false;
  return existsSync(botDir(dataDir, id)) || (manifest.bots || []).includes(id);
}

/** The folder of a user-made definition: bots/<id> for a store bot, else agents/<id>. */
export function userDefinitionDir(dataDir, id) {
  return isStoreBot(dataDir, id) ? botDir(dataDir, id) : join(dataDir, 'agents', id);
}

const isCompleteRoute = (route) =>
  Boolean(
    route && typeof route === 'object' && String(route.provider || '').trim() && String(route.model || '').trim()
  );

/** A store bot's own route (agent.json `route`): the route, null when it has
 *  none, undefined when `id` is no store bot. `fresh` reads the disk now:
 *  what a route change is computed from or compared against. */
export function readBotRoute(dataDir, id, { fresh = false } = {}) {
  if (!isStoreBot(dataDir, id)) return undefined;
  const route = cachedJson(join(botDir(dataDir, id), 'agent.json'), { fresh })?.route;
  return isCompleteRoute(route) ? route : null;
}

/** Stores (or with null removes) a store bot's route in its agent.json; every
 *  other key is kept. */
export function writeBotRoute(dataDir, id, route) {
  const file = join(botDir(dataDir, id), 'agent.json');
  const manifest = readJson(file) || {};
  if (route) manifest.route = route;
  else delete manifest.route;
  writeJsonAtomicSync(file, manifest, { backup: true });
  fileCache.set(file, manifest);
}

// --- Mixy: its own bot (bots/mixy), apart from the Lead ---
// Mixy's identity (name, face, persona, 일하는 방식, connectors, `created`)
// lives in bots/mixy once the store is active, in agents/lead before. Its
// model route is always its own (bots/mixy/agent.json `route`), never the
// Lead's: changing one never changes the other. Its home thread keeps the id
// sess_home_lead, and its runtime role id stays `lead`.

/** The folder Mixy's identity is read from and written to. */
export function mixyIdentityDir(dataDir) {
  return botStoreActive(dataDir) ? botDir(dataDir, MIXY_BOT_ID) : join(dataDir, 'agents', 'lead');
}

/** Mixy's own route, or null when it has none (its thread keeps its own). */
export function readMixyRoute(dataDir, { fresh = false } = {}) {
  if (!dataDir) return null;
  const route = cachedJson(join(botDir(dataDir, MIXY_BOT_ID), 'agent.json'), { fresh })?.route;
  return isCompleteRoute(route) ? route : null;
}

/** Stores (or with null removes) Mixy's own route; nothing of the Lead's. */
export function writeMixyRoute(dataDir, route) {
  writeBotRoute(dataDir, MIXY_BOT_ID, route);
}

/** Every config route read (configuredAgentRouteCandidates) asks the bot
 *  store first: a bot's route lives with the bot, never in the config. */
let botDataDir = () => '';
export function registerBotRouteStore(getDataDir) {
  botDataDir = getDataDir;
  setBotRouteResolver((id) => readBotRoute(getDataDir(), id));
}

/** The own route (fallbacks included) of the bot a session acts as, Mixy
 *  (runtime id `lead`) from bots/mixy; null when it has none. */
export function storedBotRoute(agentId) {
  const dataDir = botDataDir();
  if (!dataDir) return null;
  return (agentId === 'lead' ? readMixyRoute(dataDir) : readBotRoute(dataDir, agentId)) || null;
}
