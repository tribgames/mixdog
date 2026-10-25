// After the multi-account connector merge (connector-catalog.mjs
// mergeConnectorAccountServers) `gmail-2`, `google-calendar-2`… are accounts of
// one server, no longer servers. Every store of ours that keys a setting by
// MCP server name must name the surviving server instead:
//   agents/<id>/agent.json, bots/<id>/agent.json   connectors.off / connectors.tools
//                                                  (a legacy allow list too)
//   <data>/project-connectors.json                 projects.<root>.off
//   <data>/hooks.json, <data>/hooks/hooks.json     mcp_tool `server`, tool matchers
// (extension scopes are the config's and are dropped by migrateConnectorAccounts;
// an approval's "always allow" is the agent's connectors.tools; agent routes
// name models, not servers.) Project and plugin hook files are the user's or
// the plugin's own and are never rewritten here.
//
// Rule: the merged connector is OFF for an agent/project only when EVERY
// merged server was off (the same rule as the merged server's `enabled`: one
// working account keeps the connector usable). Per-tool permissions move to
// the surviving name; where two merged servers disagree on a tool the MORE
// PERMISSIVE permission wins, as "on beats off" does at server level. Entries
// of a server that was off are dormant and are dropped when the connector
// stays on, so they never become live. A setting that names no merged-away
// server is never touched, which makes every run after the first a no-op.
//
// The merge is saved to the config once, so the rename mapping outlives it:
// `<data>/connector-merge-pending.json` ({ merged: [{ name, from }] }) is
// written before any store is touched and deleted only when every store
// migrated. A store that fails (unreadable, malformed, not writable) is
// reported and the others still go on; the next start retries them all.
//
// Hooks: only tool identifiers are rewritten — an `mcp_tool` handler's
// `server`, and a matcher / tool-name field (or the tool part of an `if`
// before its `(`) that is an `mcp__<server>__…` identifier or an
// alternative of a pattern. Argument conditions such as `Bash(mcp__x__*)`
// and any other data are never touched.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRules, standardConfigReport } from './services/hook-bus/config.mjs';
import {
  PERMISSION_RANK,
  PROJECT_CONNECTORS_FILE,
  connectorEnabled,
  parseConnectorPolicy,
  storedConnectorPolicy,
} from '../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import { parseJsonText, withFileLockSync, writeJsonAtomicSync } from '../runtime/shared/atomic-file.mjs';

const unique = (list) => [...new Set(list)].sort();

/** The policy `{ off, tools }` (or a legacy `{ allow, off, tools }`) with every
 *  merged-away server of `merged` mapped onto its surviving one; null when it
 *  names none. `merged` is mergeConnectorAccountServers' `merged`. */
export function mapMergedConnectorPolicy(policy, merged) {
  let current = policy;
  for (const { name, from } of merged) {
    const gone = from.filter((server) => server !== name);
    const named = (server) =>
      current.off.includes(server) || current.allow?.includes(server) || Object.hasOwn(current.tools, server);
    if (!gone.some(named)) continue;
    const live = from.filter((server) => connectorEnabled(current, server));
    const on = live.length > 0;
    const off = current.off.filter((server) => !from.includes(server));
    const allow = current.allow?.filter((server) => !from.includes(server));
    if (allow && on) allow.push(name);
    if (!allow && !on) off.push(name);
    const tools = { ...current.tools };
    for (const server of from) delete tools[server];
    const moved = {};
    for (const server of on ? live : from) {
      for (const [tool, permission] of Object.entries(current.tools[server] || {})) {
        if (!(tool in moved) || PERMISSION_RANK[permission] > PERMISSION_RANK[moved[tool]]) moved[tool] = permission;
      }
    }
    if (Object.keys(moved).length) tools[name] = moved;
    current = { ...(allow ? { allow: unique(allow) } : {}), off: unique(off), tools };
  }
  return current === policy ? null : current;
}

/** A mapped policy as the value the agent.json `connectors` field stores
 *  (undefined: the field goes). */
function storedValue(policy) {
  if (!policy.allow) return storedConnectorPolicy(policy) ?? undefined;
  const ids = unique([...policy.allow, ...Object.keys(policy.tools)]);
  return ids.map((id) => ({
    id,
    enabled: policy.allow.includes(id),
    ...(policy.tools[id] ? { tools: policy.tools[id] } : {}),
  }));
}

export const PENDING_MERGE_FILE = 'connector-merge-pending.json';

const warn = (file, error) => process.stderr.write(`[connectors] ${file} not migrated (${error?.message || error})\n`);

/** The JSON at `file`; null when it does not exist. Any other failure throws. */
function readJsonFile(file) {
  try {
    return parseJsonText(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Runs `step` for one store; a failure is reported and returned, never thrown. */
function attempt(file, step, outcome) {
  try {
    step();
  } catch (error) {
    warn(file, error);
    outcome.failed.push(file);
  }
}

function migrateAgentFiles(dataDir, merged, outcome) {
  for (const store of ['agents', 'bots']) {
    let entries = [];
    try {
      entries = readdirSync(join(dataDir, store), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = join(dataDir, store, entry.name, 'agent.json');
      attempt(file, () => {
        const manifest = readJsonFile(file);
        if (!isRecord(manifest) || manifest.connectors == null) return;
        const next = mapMergedConnectorPolicy(parseConnectorPolicy(manifest.connectors), merged);
        if (!next) return;
        const value = storedValue(next);
        if (value) manifest.connectors = value;
        else delete manifest.connectors;
        writeJsonAtomicSync(file, manifest, { backup: true });
        outcome.agents.push(`${store}/${entry.name}`);
      }, outcome);
    }
  }
}

function migrateProjectFile(dataDir, merged, outcome) {
  const file = join(dataDir, PROJECT_CONNECTORS_FILE);
  attempt(file, () => {
    withFileLockSync(`${file}.lock`, () => {
      const document = readJsonFile(file);
      const projects = document?.projects;
      if (!isRecord(projects)) return;
      const changed = [];
      for (const [root, entry] of Object.entries(projects)) {
        if (!isRecord(entry) || !Array.isArray(entry.off)) continue;
        const next = mapMergedConnectorPolicy({ off: entry.off.map(String), tools: {} }, merged);
        if (!next) continue;
        if (next.off.length) projects[root] = { ...entry, off: next.off };
        else delete projects[root];
        changed.push(root);
      }
      if (!changed.length) return;
      writeJsonAtomicSync(file, document, { lock: false, backup: true });
      outcome.projects.push(...changed);
    });
  }, outcome);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A tool identifier or pattern (`mcp__a__x`, `^mcp__a__.*$`, `Bash|mcp__a__x`)
 *  with each `mcp__<merged-away>` alternative renamed. */
function renameToolPattern(value, renames) {
  let next = value;
  for (const [gone, name] of renames) {
    const identifier = new RegExp(`(^|\\|)(\\^?)mcp__${escapeRegExp(gone)}(?=__|(?![A-Za-z0-9_-]))`, 'g');
    next = next.replace(identifier, (_all, lead, anchor) => `${lead}${anchor}mcp__${name}`);
  }
  return next;
}

/** A condition `Tool(arguments)`: only the tool part is an identifier. */
function renameCondition(value, renames) {
  const open = value.indexOf('(');
  return open < 0 ? renameToolPattern(value, renames) : renameToolPattern(value.slice(0, open), renames) + value.slice(open);
}

/** Renames in the hook structures of `document` (in place); true when any changed. */
function renameInHooks(document, renames) {
  let changed = false;
  const set = (owner, key, rename) => {
    if (typeof owner[key] !== 'string') return;
    const next = rename(owner[key], renames);
    if (next === owner[key]) return;
    owner[key] = next;
    changed = true;
  };
  const handler = (hook) => {
    if (!isRecord(hook)) return;
    if (hook.type === 'mcp_tool') {
      if (typeof hook.server === 'string' && renames.has(hook.server.trim())) {
        hook.server = renames.get(hook.server.trim());
        changed = true;
      }
      set(hook, 'tool', renameToolPattern);
    }
    set(hook, 'if', renameCondition);
  };
  if (standardConfigReport(document).standard) {
    for (const groups of Object.values(document.hooks)) {
      for (const group of Array.isArray(groups) ? groups : []) {
        if (!isRecord(group)) continue;
        set(group, 'matcher', renameToolPattern);
        set(group, 'if', renameCondition);
        for (const hook of Array.isArray(group.hooks) ? group.hooks : []) handler(hook);
      }
    }
  } else {
    for (const rule of normalizeRules(document)) {
      if (!isRecord(rule)) continue;
      set(rule, 'tool', renameToolPattern);
      set(rule, 'name', renameToolPattern);
      set(rule, 'if', renameCondition);
    }
  }
  return changed;
}

function migrateHookFiles(dataDir, merged, outcome) {
  const renames = new Map(
    merged.flatMap(({ name, from }) => from.filter((server) => server !== name).map((gone) => [gone, name]))
  );
  for (const file of [join(dataDir, 'hooks.json'), join(dataDir, 'hooks', 'hooks.json')]) {
    attempt(file, () => {
      const document = readJsonFile(file);
      if (!isRecord(document) && !Array.isArray(document)) return;
      if (!renameInHooks(document, renames)) return;
      writeJsonAtomicSync(file, document, { backup: true });
      outcome.hooks.push(file);
    }, outcome);
  }
}

const validGroup = (group) =>
  isRecord(group) && typeof group.name === 'string' && Array.isArray(group.from) && group.from.every((n) => typeof n === 'string');

/** Maps every per-server setting of `dataDir` onto the surviving servers of
 *  `merged` (this start's merge, [] to only retry) plus any still pending from
 *  an earlier start. Returns what it rewrote and the files that failed:
 *  `{ agents, projects, hooks, failed, unrecorded? }`. The pending record is
 *  removed only when `failed` is empty; `unrecorded` says it could not be
 *  written, so the caller must not save the merge. */
export function migrateMergedConnectorServers(dataDir, merged) {
  const outcome = { agents: [], projects: [], hooks: [], failed: [] };
  if (!dataDir) return outcome;
  const pendingFile = join(dataDir, PENDING_MERGE_FILE);
  let pending = [];
  try {
    const stored = readJsonFile(pendingFile)?.merged;
    pending = Array.isArray(stored) ? stored.filter(validGroup).map(({ name, from }) => ({ name, from })) : [];
  } catch (error) {
    warn(pendingFile, error);
  }
  const groups = [...pending];
  for (const { name, from } of merged) {
    if (!groups.some((group) => group.name === name && JSON.stringify(group.from) === JSON.stringify(from))) {
      groups.push({ name, from });
    }
  }
  if (!groups.length) return outcome;
  if (groups.length !== pending.length) {
    try {
      writeJsonAtomicSync(pendingFile, { merged: groups }, { backup: false });
    } catch (error) {
      warn(pendingFile, error);
      // Nothing records the mapping: a failed store must keep the merge unsaved.
      outcome.unrecorded = true;
    }
  }
  migrateAgentFiles(dataDir, groups, outcome);
  migrateProjectFile(dataDir, groups, outcome);
  migrateHookFiles(dataDir, groups, outcome);
  if (!outcome.failed.length) rmSync(pendingFile, { force: true });
  return outcome;
}
