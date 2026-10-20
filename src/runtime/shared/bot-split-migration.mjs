// The one-time 1.3.1 split of bots out of agents/: every definition the
// read-only rule (agent-kind.mjs) classifies as a bot is COPIED from
// agents/<id>/ to bots/<id>/ with its own model route, and Mixy's identity
// from agents/lead/ to bots/mixy/. Nothing under agents/ and no session file
// is ever moved, rewritten or deleted: the originals stay for rollback and
// the manifest (bots/migration.json) tells the agent catalog which agents/
// ids are bots now. Home threads keep their ids — a bot's is still
// sess_home_<id>, Mixy's still sess_home_lead (MIXY_LEGACY_HOME_SESSION_ID) —
// so every transcript stays whole and continuable.
//
// Every later start re-syncs (migrateBotsToOwnStore): it adds nothing and
// rewrites nothing unless agents/ gained or changed a bot since (a downgrade
// to 1.3.0 and back). The re-sync never overwrites a bots/ edit: a copy is
// replaced only when its fingerprint still equals the one recorded when it
// was made (bots/ untouched since) AND its agents/ original's fingerprint
// differs and has newer files; when both sides changed, both are kept (the
// bots/ copy in use, the 1.3.0 edit left in agents/, logged). Every copy or
// replacement is preceded by a user-data backup that holds agents/ and bots/.
//
// One process migrates at a time (an exclusive lock file beside the profile,
// reclaimed when its owner died); another starting meanwhile waits for it,
// or after LOCK_WAIT_MS reads the profile as it is this start. Publishing
// the manifest is the commit point: a failure before it undoes only this
// run's own copies and leaves the profile as it was (the next start tries
// again); nothing after it is undone. A replaced bots/<id> is set aside as
// `.<id>.<run>.old` until then; the manifest names the committed ones
// (`retired`), which any later start removes, while one it does not name is
// an interrupted run's and is put back.
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { withFileLockSync, writeJsonAtomicSync } from './atomic-file.mjs';
import { evidenceKind, homeThreadEvidence } from './agent-kind.mjs';
import { BOT_AGENT_KIND } from './agent-route-config.mjs';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';
import {
  BOT_MIGRATION_MANIFEST,
  BOT_MIGRATION_VERSION,
  BOTS_DIR,
  MIXY_BOT_ID,
  migratedBotIds,
  readBotMigration,
} from './agent-store.mjs';

export { BOT_MIGRATION_MANIFEST, BOT_MIGRATION_VERSION, BOTS_DIR, MIXY_BOT_ID, migratedBotIds, readBotMigration };
/** Mixy's home thread keeps the id it always had: its messages never move. */
export const MIXY_LEGACY_HOME_SESSION_ID = 'sess_home_lead';

/** The cross-process migration lock, beside (never inside) bots/ and agents/. */
export const BOT_MIGRATION_LOCK = '.bot-split.lock';
const LOCK_WAIT_MS = 10_000;
/** What the split's backup carries besides the routine user data: every
 *  definition it copies from and every copy a re-sync can replace. */
export const BOT_SPLIT_BACKUP_DIRS = Object.freeze(['agents', BOTS_DIR]);

const DELETED_MARKER = '.deleted';
const ARCHIVED_FILE = 'AGENT.md.archived';
// Mixy's own files under agents/lead/ (its identity, persona, 일하는 방식, face).
const MIXY_IDENTITY_KEYS = ['name', 'description', 'avatar', 'connectors', 'created'];

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The definition file a bot's kind is read from: AGENT.md, or the archived
// copy of a deleted bot (its chat is kept, so it moves with the others).
export function definitionFile(dir) {
  if (existsSync(join(dir, 'AGENT.md'))) return join(dir, 'AGENT.md');
  if (existsSync(join(dir, DELETED_MARKER)) && existsSync(join(dir, ARCHIVED_FILE))) return join(dir, ARCHIVED_FILE);
  return '';
}

/** The agents/ ids the rule classifies as bots (Mixy's `lead` never). */
export function classifyBotIds({ dataDir, shippedRoot }) {
  const root = join(dataDir, 'agents');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  const bots = [];
  for (const { name: id } of entries) {
    if (id === 'lead') continue;
    const dir = join(root, id);
    const file = definitionFile(dir);
    if (!file) continue;
    const doc = readMarkdownDocument(readFileSync(file, 'utf8'));
    // The evidence rule itself, whatever the store says (a re-sync runs it
    // with the store active).
    const kind = evidenceKind({
      frontmatterKind: doc.frontmatter.kind,
      dataDir,
      shippedRoot,
      id,
      manifest: readJson(join(dir, 'agent.json')) || {},
      body: doc.body,
    });
    if (kind === BOT_AGENT_KIND) bots.push(id);
  }
  return bots.sort();
}

/** Whether agents/lead holds a Mixy the user made or used: a name, face,
 *  connectors, persona or 일하는 방식, or any conversation in its thread —
 *  never v1.3.0's untouched automatic `{"created": true}`. */
export function mixyToMigrate(dataDir) {
  const dir = join(dataDir, 'agents', 'lead');
  const manifest = readJson(join(dir, 'agent.json')) || {};
  if (manifest.created !== true) return false;
  const identity =
    Boolean(String(manifest.name ?? '').trim()) ||
    manifest.avatar != null ||
    manifest.connectors != null ||
    existsSync(join(dir, 'PERSONA.md')) ||
    existsSync(join(dir, 'AGENT.md'));
  return identity || homeThreadEvidence(dataDir, 'lead').chatted;
}

// The provider/model Mixy's thread runs on, or null.
function threadRoute(dataDir, sessionId) {
  const record = readJson(join(dataDir, 'sessions', `${sessionId}.json`));
  const provider = String(record?.provider || '').trim();
  const model = String(record?.model || '').trim();
  return provider && model ? { provider, model } : null;
}

const completeRoute = (route) =>
  route && typeof route === 'object' && String(route.provider || '').trim() && String(route.model || '').trim()
    ? route
    : null;

// --- Content fingerprints (for the re-sync rule) ---
// A folder's files as one hash; agent.json without the keys only the store
// writes (a bot's route, Mixy's thread id and created flag), so changing a
// bot's model on 1.3.1 never counts as editing its definition.
const STORE_ONLY_KEYS = ['route', 'homeSessionId', 'created'];

function folderFiles(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
      .filter((file) => !file.endsWith('.lock'))
      .sort();
  } catch {
    return [];
  }
}

// A JSON value with every object's keys sorted, nested ones included (a
// replacer array would drop every nested key not in the top-level list).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

function folderHash(dir) {
  const hash = createHash('sha256');
  for (const file of folderFiles(dir)) {
    let bytes = readFileSync(file);
    const manifest = basename(file) === 'agent.json' && dirname(file) === dir ? readJson(file) : null;
    if (manifest) {
      for (const key of STORE_ONLY_KEYS) delete manifest[key];
      bytes = Buffer.from(JSON.stringify(canonical(manifest)));
    }
    hash
      .update(`${relative(dir, file)}\0`)
      .update(bytes)
      .update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function newestChange(dir) {
  let newest = 0;
  for (const file of folderFiles(dir)) newest = Math.max(newest, statSync(file).mtimeMs);
  return newest;
}

// A staging or set-aside folder an earlier run left (`.<id>.<pid>-<time>.<kind>`).
// Swept under the migration lock, so no run that made one is still going.
const LEFTOVER = /^\.(.+)\.(\d+)-\d+\.(staging|old)$/;
const removeBestEffort = (path) => {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // a later start removes it
  }
};
// A staging folder goes; a set-aside `.old` the manifest names as retired is
// a committed swap's rest and goes; any other `.old` is the bot as it was
// before a run that never committed: it is put back (a failure here fails
// this run, which then leaves the profile as it is).
function sweepLeftovers(botsRoot, retired) {
  for (const name of existsSync(botsRoot) ? readdirSync(botsRoot) : []) {
    const match = LEFTOVER.exec(name);
    if (!match) continue;
    const path = join(botsRoot, name);
    if (match[3] === 'staging' || retired.has(name)) {
      removeBestEffort(path);
      continue;
    }
    const target = join(botsRoot, match[1]);
    if (existsSync(target)) {
      const aside = join(botsRoot, `.${match[1]}.${match[2]}-0.staging`);
      renameSync(target, aside);
      removeBestEffort(aside);
    }
    renameSync(path, target);
  }
}

// The finished split's record as on disk now (never a cached read: another
// process may have just written it).
function readManifestNow(botsRoot) {
  const manifest = readJson(join(botsRoot, BOT_MIGRATION_MANIFEST));
  return manifest?.version === BOT_MIGRATION_VERSION ? manifest : null;
}

/**
 * Runs the split, and on every later start the re-sync (`backup()` first
 * whenever something is to be copied). `routeOf(id)` is the bot's route in
 * the config (null when none); `leadRoute` the Lead's route at this time
 * (Mixy's route when its thread names none).
 *
 * First run: every bot in agents/ is copied to bots/<id> (a bots/<id>
 * already there — a concurrent run's, a hand-made or restored folder — is
 * kept as it is and adopted), and a used Mixy to bots/mixy.
 * Later runs (the manifest exists), so a downgrade to 1.3.0 and back loses
 * nothing:
 *  - a bot 1.3.0 made in agents/ after the split is copied over as above;
 *  - a migrated bot whose agents/ original was edited after its copy (newer
 *    files, other content) while its bots/ copy was left as copied is
 *    copied again, keeping its bots/ route; when both sides changed the
 *    bots/ copy wins and the edit stays in agents/ (logged);
 *  - a migrated bot whose bots/<id> is gone (deleted for good) never comes
 *    back from its agents/ original;
 *  - Mixy, once made or used in agents/lead, fills what bots/mixy lacks.
 * Every copy is staged and swapped in by rename; a failure before the
 * manifest is published puts back what this run replaced, removes what it
 * added, writes no manifest and leaves agents/ and every session untouched.
 *
 * Runs under the cross-process migration lock: a second process waits up to
 * `lockWaitMs`, then reads the profile as it is (`{ failed, busy }`).
 * `afterPublish` is an interleaving point for tests (a failure there is one
 * after the commit point).
 */
export function migrateBotsToOwnStore(options) {
  const { dataDir, log, lockWaitMs = LOCK_WAIT_MS } = options;
  try {
    return withFileLockSync(join(dataDir, BOT_MIGRATION_LOCK), () => migrateLocked(options), {
      timeoutMs: lockWaitMs,
    });
  } catch (error) {
    // Only the lock fails here (migrateLocked reports its own failures).
    const done = readBotMigration(dataDir);
    log?.(`[bot-split] another start is migrating; this one reads the profile as it is: ${error?.message || error}`);
    return { skipped: false, failed: true, busy: true, bots: done?.bots || [], mixy: done?.mixy === true };
  }
}

function migrateLocked({ dataDir, shippedRoot, routeOf = () => null, leadRoute = null, backup, log, afterPublish }) {
  const botsRoot = join(dataDir, BOTS_DIR);
  const done = readManifestNow(botsRoot);
  const runTag = `${process.pid}-${Date.now()}`;
  // What this run changed, undone in reverse on a failure before the commit.
  const changes = [];
  let backedUp = false;
  const beforeCopy = () => {
    if (backedUp) return;
    backedUp = true;
    backup?.();
  };
  // Swaps a staged folder in for bots/<id> (atomic renames); the replaced
  // folder is set aside as `.old` until the commit.
  const swapIn = (id, staging, { replace }) => {
    const target = join(botsRoot, id);
    let old = '';
    if (replace && existsSync(target)) {
      old = join(botsRoot, `.${id}.${runTag}.old`);
      renameSync(target, old);
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      removeBestEffort(staging);
      // Should this fail too, the next start's sweep puts the `.old` back.
      if (old) renameSync(old, target);
      throw error;
    }
    changes.push({ target, old });
  };
  const stage = (id, source) => {
    const staging = join(botsRoot, `.${id}.${runTag}.staging`);
    rmSync(staging, { recursive: true, force: true });
    if (source) cpSync(source, staging, { recursive: true });
    else mkdirSync(staging, { recursive: true });
    return staging;
  };
  let next;
  try {
    mkdirSync(botsRoot, { recursive: true });
    sweepLeftovers(botsRoot, new Set(done?.retired || []));
    // Committed set-asides the sweep could not remove stay named for a later start.
    const retired = (done?.retired || []).filter((name) => existsSync(join(botsRoot, name)));
    const copies = { ...(done?.copies || {}) };
    const bots = new Set(done?.bots || []);
    const record = (id, sourceDir) => {
      copies[id] = { source: folderHash(sourceDir), copy: folderHash(join(botsRoot, id)), at: Date.now() };
    };
    // 1. Bots in agents/ not yet in the store.
    for (const id of classifyBotIds({ dataDir, shippedRoot })) {
      if (bots.has(id)) continue;
      const source = join(dataDir, 'agents', id);
      if (!existsSync(join(botsRoot, id))) {
        beforeCopy();
        const route = completeRoute(routeOf(id));
        const staging = stage(id, source);
        const manifest = readJson(join(staging, 'agent.json')) || {};
        writeJson(join(staging, 'agent.json'), { ...manifest, ...(route ? { route } : {}) });
        swapIn(id, staging, { replace: false });
      }
      bots.add(id);
      record(id, source);
    }
    // 2. Migrated bots edited in agents/ after their copy (a 1.3.0 round trip).
    for (const id of done ? [...bots] : []) {
      const source = join(dataDir, 'agents', id);
      const target = join(botsRoot, id);
      const entry = copies[id];
      if (!entry || !existsSync(target) || !existsSync(source)) continue;
      const sourceChanged = folderHash(source) !== entry.source && newestChange(source) > entry.at;
      if (!sourceChanged) continue;
      if (folderHash(target) !== entry.copy) {
        log?.(`[bot-split] ${id}: edited in both agents/ and bots/; the bots/ copy is kept`);
        continue;
      }
      beforeCopy();
      const route = readJson(join(target, 'agent.json'))?.route;
      const staging = stage(id, source);
      const manifest = readJson(join(staging, 'agent.json')) || {};
      writeJson(join(staging, 'agent.json'), { ...manifest, ...(completeRoute(route) ? { route } : {}) });
      swapIn(id, staging, { replace: true });
      record(id, source);
    }
    // 3. Mixy: made or used in agents/lead; bots/mixy keeps what it has.
    let mixy = done?.mixy === true;
    const leadDir = join(dataDir, 'agents', 'lead');
    const mixyDir = join(botsRoot, MIXY_BOT_ID);
    const mixyEntry = copies[MIXY_BOT_ID];
    const leadEdited =
      mixyEntry &&
      existsSync(mixyDir) &&
      folderHash(leadDir) !== mixyEntry.source &&
      newestChange(leadDir) > mixyEntry.at;
    if (mixyToMigrate(dataDir) && (!mixyEntry || leadEdited)) {
      const current = existsSync(mixyDir) ? readJson(join(mixyDir, 'agent.json')) || {} : {};
      const untouched = mixyEntry && folderHash(mixyDir) === mixyEntry.copy;
      if (mixyEntry && !untouched) {
        log?.('[bot-split] Mixy: edited in both agents/lead and bots/mixy; bots/mixy is kept');
      } else {
        beforeCopy();
        // A first copy fills what bots/mixy lacks (the host may have written
        // its flag or route there); a re-sync takes agents/lead's identity.
        const staging = stage(MIXY_BOT_ID, existsSync(mixyDir) && !mixyEntry ? mixyDir : null);
        for (const name of folderFiles(leadDir).map((file) => relative(leadDir, file))) {
          if (name === 'agent.json' || (existsSync(join(staging, name)) && !mixyEntry)) continue;
          mkdirSync(dirname(join(staging, name)), { recursive: true });
          cpSync(join(leadDir, name), join(staging, name));
        }
        const lead = readJson(join(leadDir, 'agent.json')) || {};
        const identity = Object.fromEntries(
          MIXY_IDENTITY_KEYS.filter((key) => key in lead).map((key) => [key, lead[key]])
        );
        const route =
          completeRoute(current.route) || threadRoute(dataDir, MIXY_LEGACY_HOME_SESSION_ID) || completeRoute(leadRoute);
        writeJson(join(staging, 'agent.json'), {
          ...identity,
          ...(mixyEntry ? {} : current),
          ...(typeof current.created === 'boolean' ? { created: current.created } : {}),
          ...(route ? { route } : {}),
          homeSessionId: MIXY_LEGACY_HOME_SESSION_ID,
        });
        swapIn(MIXY_BOT_ID, staging, { replace: true });
        record(MIXY_BOT_ID, leadDir);
        mixy = true;
      }
    }
    retired.push(...changes.filter(({ old }) => old).map(({ old }) => basename(old)));
    next = {
      version: BOT_MIGRATION_VERSION,
      completedAt: done?.completedAt || new Date().toISOString(),
      bots: [...bots].sort(),
      mixy,
      mixyHomeSessionId: mixy ? MIXY_LEGACY_HOME_SESSION_ID : null,
      copies,
      ...(retired.length ? { retired: retired.sort() } : {}),
    };
    // The commit point: once this rename lands, nothing of this run is undone.
    if (!done || changes.length || JSON.stringify(next) !== JSON.stringify(done)) {
      writeJsonAtomicSync(join(botsRoot, BOT_MIGRATION_MANIFEST), next, { mode: 0o644 });
    }
  } catch (error) {
    // Undo this run: what it added goes, what it replaced comes back. A step
    // that fails leaves an unretired `.old` the next start's sweep puts back.
    for (const { target, old } of changes.reverse()) {
      try {
        const aside = join(botsRoot, `.${basename(target)}.${runTag}.staging`);
        renameSync(target, aside);
        if (old) renameSync(old, target);
        removeBestEffort(aside);
      } catch {
        // the leftover sweep of a later start finishes it
      }
    }
    for (const name of existsSync(botsRoot) ? readdirSync(botsRoot) : []) {
      if (name.endsWith(`.${runTag}.staging`)) removeBestEffort(join(botsRoot, name));
    }
    log?.(`[bot-split] migration failed; the profile is unchanged: ${error?.message || error}`);
    return { skipped: false, failed: true, bots: done?.bots || [], mixy: done?.mixy === true };
  }
  // Committed. Removing the set-aside copies is best-effort: the manifest
  // names them as retired, so a later start removes what is left.
  try {
    afterPublish?.();
    for (const { old } of changes) if (old) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    log?.(`[bot-split] committed; leftover cleanup is retried next start: ${error?.message || error}`);
  }
  if (done && !changes.length) return { skipped: true, bots: next.bots, mixy: next.mixy };
  return { skipped: false, bots: next.bots, mixy: next.mixy, changed: changes.map(({ target }) => basename(target)) };
}
