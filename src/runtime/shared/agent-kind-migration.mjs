// The one-time `kind: agent` stamp for agents made before the kind marker
// existed. v1.3.0 read an unmarked user-made agent as a bot, so a user's
// older workflow agents ("Explorer", "Measurer") silently turned into bots
// (and 1.3.1's evidence rule, agent-kind.mjs, still reads a few of them as
// bots). This migration writes the marker into AGENT.md so the kind no longer
// rests on a rule that can change, without touching any other front matter.
//
// An unmarked user-made agent (not Mixy, not a shipped, hidden or roster
// role) in agents/ is stamped `kind: agent` when
//   - the evidence rule reads it as a workflow agent (no creation greeting,
//     no dialog avatar + default body): it always was one; or
//   - it was delegated work by a Lead (agent-workers.json: a worker row of
//     that agent whose owner session is no home thread or room): only a
//     workflow agent is handed work that way (Mixy's contacts are owned by
//     its home thread), so this outweighs bot-looking evidence. A bot the
//     1.3.1 split already moved to bots/ is restored by it: its bots/ files
//     (and route) come back to agents/, stamped, and bots/<id> goes.
// Anything else — a real bot — is left alone, and so is every explicit kind.
//
// One time (agent-kind-migration.json), idempotent (only unmarked files are
// written), under the bot-split lock, after a user-data backup.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHiddenAgent } from '../agent/orchestrator/internal-agents.mjs';
import { isAgentHomeSessionId } from '../agent/orchestrator/session/agent-home.mjs';
import { withFileLockSync, writeJsonAtomicSync } from './atomic-file.mjs';
import { evidenceKind } from './agent-kind.mjs';
import { DEFAULT_DISABLED_AGENT_ROSTER, WORKFLOW_AGENT_KIND } from './agent-route-config.mjs';
import { BOT_MIGRATION_LOCK, definitionFile } from './bot-split-migration.mjs';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';
import { BOT_MIGRATION_MANIFEST, BOT_MIGRATION_VERSION, BOTS_DIR } from './agent-store.mjs';

export const AGENT_KIND_MIGRATION_FILE = 'agent-kind-migration.json';
export const AGENT_KIND_MIGRATION_VERSION = 1;
const LOCK_WAIT_MS = 10_000;
/** Keys only the bot store writes into a bot's agent.json. */
const STORE_ONLY_KEYS = ['route', 'homeSessionId'];
const ROOM_SESSION_PREFIX = 'sess_rmem_';

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The agent ids a Lead delegated work to (agent-workers.json), lower-cased. */
export function delegatedAgentIds(dataDir) {
  const workers = readJson(join(dataDir, 'agent-workers.json'))?.workers;
  let rows = [];
  if (Array.isArray(workers)) rows = workers;
  else if (workers && typeof workers === 'object') rows = Object.values(workers);
  const ids = new Set();
  for (const row of rows) {
    const agent = String(row?.agent ?? '')
      .trim()
      .toLowerCase();
    const owner = String(row?.ownerSessionId || row?.parentSessionId || '').trim();
    if (!agent || agent === 'lead' || !owner) continue;
    if (isAgentHomeSessionId(owner) || owner.startsWith(ROOM_SESSION_PREFIX)) continue;
    ids.add(agent);
  }
  return ids;
}

/** AGENT.md text with `kind: agent` in its front matter, every other line kept. */
export function withAgentKindMarker(text) {
  const marker = `kind: ${WORKFLOW_AGENT_KIND}`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!block) return `---${eol}${marker}${eol}---${eol}${eol}${text}`;
  const lines = block[2].split(/\r?\n/);
  const at = lines.findIndex((line) => /^kind:/.test(line));
  if (at >= 0) lines[at] = marker;
  else lines.push(marker);
  return `${block[1]}${lines.join(eol)}${block[3]}${text.slice(block[0].length)}`;
}

function stampFile(file) {
  writeFileSync(file, withAgentKindMarker(readFileSync(file, 'utf8')));
}

/**
 * Runs the stamp once. `backup()` runs before the first write; `restoreRoute(id,
 * route)` receives the own route of a restored bot (it lived in bots/<id>,
 * workflow agent routes live in the config). Returns `{ skipped }` once done,
 * else `{ stamped, restored }`; a failure writes no record, so the next start
 * retries (what was written stays valid: every step is idempotent).
 */
export function migrateAgentKinds({
  dataDir,
  shippedRoot,
  backup,
  restoreRoute,
  log,
  step,
  lockWaitMs = LOCK_WAIT_MS,
}) {
  const record = join(dataDir, AGENT_KIND_MIGRATION_FILE);
  try {
    return withFileLockSync(
      join(dataDir, BOT_MIGRATION_LOCK),
      () => {
        if (readJson(record)?.version === AGENT_KIND_MIGRATION_VERSION)
          return { skipped: true, stamped: [], restored: [] };
        return run({ dataDir, shippedRoot, backup, restoreRoute, step, record });
      },
      { timeoutMs: lockWaitMs }
    );
  } catch (error) {
    log?.(`[agent-kind] migration failed; it is retried next start: ${error?.message || error}`);
    return { skipped: false, failed: true, stamped: [], restored: [] };
  }
}

function run({ dataDir, shippedRoot, backup, restoreRoute, step, record }) {
  const agentsRoot = join(dataDir, 'agents');
  const botsRoot = join(dataDir, BOTS_DIR);
  const manifestFile = join(botsRoot, BOT_MIGRATION_MANIFEST);
  const split = readJson(manifestFile);
  const store = split?.version === BOT_MIGRATION_VERSION ? split : null;
  const delegated = delegatedAgentIds(dataDir);
  const stamp = [];
  const restore = [];
  for (const entry of existsSync(agentsRoot) ? readdirSync(agentsRoot, { withFileTypes: true }) : []) {
    const id = entry.name;
    if (!entry.isDirectory() || id.startsWith('.') || id === 'lead') continue;
    if (isHiddenAgent(id) || DEFAULT_DISABLED_AGENT_ROSTER.includes(id)) continue;
    if (shippedRoot && existsSync(join(shippedRoot, 'agents', id, 'AGENT.md'))) continue;
    const dir = join(agentsRoot, id);
    const file = definitionFile(dir);
    if (!file) continue;
    const doc = readMarkdownDocument(readFileSync(file, 'utf8'));
    // A split bot is judged on its bots/ copy, before the explicit-kind skip:
    // an interrupted restore may already have stamped agents/<id> while
    // bots/<id> is still there, and the next run must finish it.
    if (store && existsSync(join(botsRoot, id))) {
      const botFile = definitionFile(join(botsRoot, id));
      const botKind = botFile ? readMarkdownDocument(readFileSync(botFile, 'utf8')).frontmatter.kind : '';
      if (delegated.has(id) && !botKind) restore.push(id);
      continue;
    }
    if (doc.frontmatter.kind) continue;
    if (store && (store.bots || []).includes(id)) continue;
    const bot =
      evidenceKind({
        frontmatterKind: doc.frontmatter.kind,
        dataDir,
        shippedRoot,
        id,
        manifest: readJson(join(dir, 'agent.json')) || {},
        body: doc.body,
      }) === 'bot';
    if (!bot || delegated.has(id)) stamp.push(id);
  }
  if (stamp.length || restore.length) backup?.();
  for (const id of stamp) stampFile(definitionFile(join(agentsRoot, id)));
  // Each restore is ordered so a failure at any step leaves bots/<id> intact
  // (it stays the bot's source, so the next start redoes every step): files
  // and route first, then the split manifest, the stamp, and only then the
  // delete of bots/<id>, which is what ends the restore.
  for (const id of restore) {
    const source = join(botsRoot, id);
    const target = join(agentsRoot, id);
    // The bot's files (edited since the split) are the definition to keep.
    step?.('copy', id);
    cpSync(source, target, { recursive: true, force: true });
    const route = readJson(join(source, 'agent.json'))?.route;
    const manifest = readJson(join(target, 'agent.json'));
    if (manifest) {
      for (const key of STORE_ONLY_KEYS) delete manifest[key];
      writeFileSync(join(target, 'agent.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
    step?.('route', id);
    if (route?.provider && route?.model) restoreRoute?.(id, route);
    step?.('manifest', id);
    const copies = { ...(store.copies || {}) };
    delete copies[id];
    store.bots = (store.bots || []).filter((botId) => botId !== id);
    store.copies = copies;
    writeJsonAtomicSync(manifestFile, store, { mode: 0o644 });
    step?.('stamp', id);
    stampFile(definitionFile(target));
    step?.('delete', id);
    rmSync(source, { recursive: true, force: true });
  }
  writeJsonAtomicSync(
    record,
    {
      version: AGENT_KIND_MIGRATION_VERSION,
      completedAt: new Date().toISOString(),
      stamped: stamp.sort(),
      restored: restore.sort(),
    },
    { mode: 0o644 }
  );
  return { skipped: false, stamped: stamp, restored: restore };
}
