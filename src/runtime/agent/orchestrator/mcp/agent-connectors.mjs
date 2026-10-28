// Connector policy: which globally installed MCP servers (connectors) an agent
// or a project may use. Every installed connector is on by default for every
// agent and project, existing and future ones; a policy only switches some off:
//   agents/<id>/agent.json   connectors: { off: [serverId…], tools?: { [serverId]: { [tool]: permission } } }
//                            (bots/<id>/ for a store bot; Mixy — runtime id `lead` — in her identity folder)
//   <data>/project-connectors.json   { projects: { [projectRoot]: { off: [serverId…] } } }
// `tools` keeps per-tool overrides (auto | needs_approval | disabled); a tool
// without one is auto, except a catalog connector's high-risk tools, which
// ask (connectorToolDefault). A legacy agent list (an array: only its enabled
// entries were mounted) is enforced as written until the host converts it
// (migrateLegacyConnectorPolicy). A policy that cannot be read, or has neither
// shape, mounts nothing. Enforced at dispatch only: every session lists every
// connected tool, so the schema and the BP2 manifest stay shared.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { holdsNoData, parseJsonText, readJsonStateSync } from '../../../shared/atomic-file.mjs';

const NO_DATA = new Error('the file holds no data');
import { cwdWithinProjects } from '../../../shared/extension-scopes.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { mixyIdentityDir, userDefinitionDir } from '../../../shared/agent-store.mjs';
import { isSelfMcpToolName, parseMcpToolName } from '../../../shared/tool-primitives.mjs';
import { connectorById, connectorToolDefault } from '../../../shared/connector-catalog.mjs';
import { MIXY_AGENT_ID } from '../session/agent-home.mjs';
import { AGENT_MODE, sessionModeOf } from '../session/agent-mode.mjs';
import { serverConnector } from './server-connectors.mjs';

export const CONNECTOR_PERMISSIONS = Object.freeze(['auto', 'needs_approval', 'disabled']);
export const PROJECT_CONNECTORS_FILE = 'project-connectors.json';

/** What an unreadable or malformed policy means: no connector is on. */
export const DENY_ALL_CONNECTORS = Object.freeze({
  allow: Object.freeze([]),
  off: Object.freeze([]),
  tools: Object.freeze({}),
});

const AGENT_DIR_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const POLICY_KEYS = new Set(['off', 'tools']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const uniqueIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(clean).filter(Boolean))].sort();

function toolOverrides(value) {
  const out = {};
  for (const [server, tools] of Object.entries(isPlainObject(value) ? value : {})) {
    const own = {};
    for (const [tool, permission] of Object.entries(isPlainObject(tools) ? tools : {})) {
      if (clean(tool) && CONNECTOR_PERMISSIONS.includes(permission)) own[clean(tool)] = permission;
    }
    if (clean(server) && Object.keys(own).length) out[clean(server)] = own;
  }
  return out;
}

/** A stored `connectors` field → `{ off, tools }`, or `{ allow, off, tools }`
 *  for a legacy list; null when absent. Throws on any other shape. */
export function parseConnectorPolicy(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const allow = [];
    const tools = {};
    for (const item of value) {
      const id = clean(item?.id);
      if (!id) continue;
      if (item.enabled === true) allow.push(id);
      const own = toolOverrides({ [id]: item.tools })[id];
      if (own) tools[id] = { ...tools[id], ...own };
    }
    return { allow: uniqueIds(allow), off: [], tools };
  }
  if (!isPlainObject(value) || Object.keys(value).some((key) => !POLICY_KEYS.has(key))) {
    throw new Error('connectors must be { off: [connector id…], tools? }');
  }
  if (value.off != null && !Array.isArray(value.off)) throw new Error('connectors.off must be a list');
  if (value.tools != null && !isPlainObject(value.tools)) throw new Error('connectors.tools must be an object');
  return { off: uniqueIds(value.off), tools: toolOverrides(value.tools) };
}

/** The form a deny-list policy is saved in; null when it switches nothing off
 *  (the same as no policy). A legacy list must be migrated first. */
export function storedConnectorPolicy(policy) {
  if (!policy) return null;
  if (policy.allow) throw new Error('a legacy connector list must be migrated before it is saved');
  const off = uniqueIds(policy.off);
  const tools = toolOverrides(policy.tools);
  if (!off.length && !Object.keys(tools).length) return null;
  return { off, ...(Object.keys(tools).length ? { tools } : {}) };
}

/** A legacy list (or an unreadable policy) as the equivalent deny list over
 *  the installed connectors `installedIds`: each one it did not enable is off.
 *  A deny-list policy (or none) passes through. */
export function migrateLegacyConnectorPolicy(policy, installedIds) {
  if (!policy?.allow) return policy;
  const allow = new Set(policy.allow);
  const missing = uniqueIds(installedIds).filter((id) => !allow.has(id));
  return { off: uniqueIds([...policy.off, ...missing]), tools: toolOverrides(policy.tools) };
}

/** Whether connector `serverId` is on under `policy` (null: every one is). */
export function connectorEnabled(policy, serverId) {
  if (!policy) return true;
  if (policy.allow && !policy.allow.includes(serverId)) return false;
  return !policy.off.includes(serverId);
}

// Policy files are stat-checked on every read (tiny files), so a save from
// any process applies to the next dispatch without an explicit flush.
const fileCache = new Map();

function cachedRead(path, read) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    // No file is the "no policy" state; any other fault means it cannot be read.
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : unreadable(path, error);
  }
  const cached = fileCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const value = read(path);
  fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function readJson(path, parse) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : unreadable(path, error);
  }
  try {
    if (holdsNoData(text)) throw NO_DATA;
    return parse(parseJsonText(text));
  } catch (error) {
    return recoverDamaged(path, parse, error);
  }
}

// A damaged policy (empty, NUL-filled, torn, invalid) must never fail open.
// With a valid last good copy `<file>.bak` the damaged file is kept aside and
// the copy restored, so the user's deny list survives. Without one the file
// stays where it is (`keepWithoutBackup`) and every connector stays off until
// the policy is saved again — moving it aside would make the next read "no
// policy" (all on). A busy recovery lock also answers deny-all.
function recoverDamaged(path, parse, error) {
  try {
    const value = readJsonStateSync(path, { validate: parse, fallback: DENY_ALL_CONNECTORS, keepWithoutBackup: true });
    return value === DENY_ALL_CONNECTORS ? unreadable(path, error) : value;
  } catch (recoveryError) {
    return unreadable(path, recoveryError);
  }
}

// A policy that exists but cannot be trusted mounts nothing.
function unreadable(path, error) {
  process.stderr.write(`[connectors] ${path} is unreadable (${error?.message || error}); denying all connectors\n`);
  return DENY_ALL_CONNECTORS;
}

/** Uncached: the policy in the agent.json at `path` (see parseConnectorPolicy);
 *  null without a file or field, DENY_ALL_CONNECTORS when it cannot be
 *  trusted. The agent editor reads the policy through this too. */
export function readConnectorsFile(path) {
  return readJson(path, (manifest) => parseConnectorPolicy(manifest?.connectors));
}

/** The agent's saved policy under `dataDir`, or null when it has none. Mixy's
 *  runtime id is `lead`: her policy is in her identity folder (bots/mixy once
 *  the bot store is active, agents/lead before), the file her profile writes. */
export function agentConnectors(agentId, dataDir = resolvePluginData()) {
  const id = clean(agentId);
  if (!id || !AGENT_DIR_ID.test(id)) return null;
  const dir = id === MIXY_AGENT_ID ? mixyIdentityDir(dataDir) : userDefinitionDir(dataDir, id);
  return cachedRead(join(dir, 'agent.json'), readConnectorsFile);
}

/** The agent whose connector policy `session` runs under. A coding Lead shares
 *  Mixy's runtime id `lead` but is not her: the policy her profile edits is
 *  hers alone, so a coding Lead has none ('') and only its Project's applies. */
export function connectorPolicyAgentOf(session) {
  const agent = clean(session?.agent);
  return agent === MIXY_AGENT_ID && sessionModeOf(session) !== AGENT_MODE ? '' : agent;
}

/** Uncached: the project policy file → `[{ root, off }]`, null without one,
 *  DENY_ALL_CONNECTORS when it cannot be trusted. */
export function readProjectConnectorsFile(path) {
  return readJson(path, (raw) => {
    if (!isPlainObject(raw) || (raw.projects != null && !isPlainObject(raw.projects))) {
      throw new Error('projects must be an object');
    }
    return Object.entries(raw.projects || {}).flatMap(([root, entry]) => {
      if (!isPlainObject(entry) || (entry.off != null && !Array.isArray(entry.off))) {
        throw new Error(`project "${root}" must be { off: [connector id…] }`);
      }
      const off = uniqueIds(entry.off);
      return clean(root) && off.length ? [{ root: clean(root), off }] : [];
    });
  });
}

function projectConnectorPolicies(dataDir = resolvePluginData()) {
  return cachedRead(join(dataDir, PROJECT_CONNECTORS_FILE), readProjectConnectorsFile);
}

/** 'auto' | 'needs_approval' | 'disabled' for an MCP tool (definition or name)
 *  under an agent's policy. Non-MCP tools and Mixdog's own self server are
 *  not connectors: always 'auto'. */
export function connectorToolPermission(policy, toolOrName) {
  const mcp = parseMcpToolName(toolOrName);
  if (!mcp || isSelfMcpToolName(toolOrName)) return 'auto';
  if (policy && !connectorEnabled(policy, mcp.server)) return 'disabled';
  // An explicit per-tool entry of the tool's connector decides; otherwise a
  // catalog connector's high-risk tools ask (connectorToolDefault) and any
  // other tool is auto.
  const [own] = connectorToolEntries(policy?.tools, connectorGroupId(mcp.server), mcp.tool);
  return own || connectorToolDefault(serverConnector(mcp.server), mcp.tool);
}

export const PERMISSION_RANK = Object.freeze({ disabled: 0, needs_approval: 1, auto: 2 });

/** The connector a server (account) belongs to: `gmail-2` → `gmail` for a
 *  catalog connector; any other id is its own. A tool's permission is stored
 *  once, under this id, and governs every account. */
export function connectorGroupId(serverId) {
  const base = String(serverId).replace(/-\d+$/, '');
  return base !== serverId && connectorById(base) ? base : serverId;
}

const accountNumber = (id) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0);

/** The entries for `tool` under the connector `group` or any of its accounts,
 *  topmost first: the connector's own, then the lowest-numbered account. An
 *  account only holds one in data saved before permissions were kept per
 *  connector; the first entry is the one that applies. */
export function connectorToolEntries(tools, group, tool) {
  return Object.entries(tools || {})
    .filter(([id, own]) => connectorGroupId(id) === group && CONNECTOR_PERMISSIONS.includes(own?.[tool]))
    .sort(([a], [b]) => accountNumber(a) - accountNumber(b))
    .map(([, own]) => own[tool]);
}

const UNLISTED_ACCOUNT = '\0unlisted account';

/** Rank of `tool` on one account of connector `group`: 0 when that account is
 *  off, else the topmost entry for the connector, else `unset` (no override:
 *  at least asks / at most runs freely). */
const accountRank = (tools, off, account, group, tool, unset) =>
  off.has(account) ? 0 : (PERMISSION_RANK[connectorToolEntries(tools, group, tool)[0]] ?? unset);
export const NO_WIDEN_MESSAGE = 'This change would widen what the bot may do without asking; make it on the desktop.';

/** Whether replacing the stored policy `before` (a stored value, a parsed
 *  policy or null) with `after` (`{ off, tools }` or null) could give any
 *  tool more authority, judged on EFFECTIVE permissions: a connector switched
 *  back on, a tool allowed, or an override removed (the tool then runs on its
 *  default, which is `needs_approval` for a catalog connector's high-risk
 *  tools and `auto` otherwise). A legacy allow list or an unreadable policy is
 *  not compared: it counts as widening. */
function connectorPolicyWidens(before, after) {
  let old;
  try {
    old = before == null ? { off: [], tools: {} } : parseConnectorPolicy(before);
  } catch {
    return true;
  }
  if (old.allow) return true;
  const next = after == null ? { off: [], tools: {} } : after;
  const offBefore = new Set(old.off);
  const offAfter = new Set(next.off || []);
  for (const server of offBefore) if (!offAfter.has(server)) return true;
  const toolsBefore = old.tools || {};
  const toolsAfter = next.tools || {};
  // Judged per connector and tool: the accounts of one connector share them.
  const pairs = new Set(
    [toolsBefore, toolsAfter].flatMap((tools) =>
      Object.entries(tools).flatMap(([id, own]) => Object.keys(own || {}).map((tool) => `${connectorGroupId(id)}\0${tool}`))
    )
  );
  for (const pair of pairs) {
    const [group, tool] = pair.split('\0');
    // Each account on its own: one that is off does not hold back its siblings.
    // Plus one account the policy never names: it is on in both policies, so it
    // stands for every installed account that is not listed.
    const accounts = new Set([
      UNLISTED_ACCOUNT,
      ...[group, ...offBefore, ...offAfter, ...Object.keys(toolsBefore), ...Object.keys(toolsAfter)].filter(
        (id) => connectorGroupId(id) === group
      ),
    ]);
    for (const account of accounts) {
      const was = accountRank(toolsBefore, offBefore, account, group, tool, 1);
      const now = accountRank(toolsAfter, offAfter, account, group, tool, 2);
      if (now > was) return true;
    }
  }
  return false;
}

/** The `code` of the error a refused widening throws. */
export const CONNECTOR_POLICY_WIDENS = 'CONNECTOR_POLICY_WIDENS';
/** An approved tool change met a restriction newer than its request. */
export const CONNECTOR_TOOL_NARROWED = 'CONNECTOR_TOOL_NARROWED';
/** An approved tool change found the tool already at that level or more. */
export const CONNECTOR_TOOL_ALREADY = 'CONNECTOR_TOOL_ALREADY';

const codedError = (code, message) => Object.assign(new Error(message), { code });

// The one change a person approved on a card (setup-tool connector-widen-approval.mjs),
// set only for the synchronous stretch of its write.
let approvedToolChange = null;

/** Run `write` (a writer whose noWiden check runs synchronously, before it
 *  writes) with one approved change `{ server, tool, from, to }`: its check
 *  then lets exactly that tool go to `to`, judged on the stored policy it
 *  writes over, and nothing else widen. Returns what `write` returns. */
export function withApprovedConnectorToolChange(change, write) {
  approvedToolChange = change;
  try {
    return write();
  } finally {
    approvedToolChange = null;
  }
}

// The approved tool's entries (the connector's, and any account's) pinned to
// one value in both policies, so the comparison judges every other tool and switch.
const pinTool = (policy, group, tool) => {
  const tools = Object.fromEntries(
    Object.entries(policy?.tools || {}).map(([id, own]) => [
      id,
      connectorGroupId(id) === group ? { ...own, [tool]: 'disabled' } : own,
    ])
  );
  tools[group] = { ...tools[group], [tool]: 'disabled' };
  return { off: policy?.off || [], tools };
};

function assertApprovedToolChange(before, after, { server, tool, from, to }) {
  let old;
  try {
    old = before == null ? { off: [], tools: {} } : parseConnectorPolicy(before);
  } catch {
    throw codedError(CONNECTOR_POLICY_WIDENS, NO_WIDEN_MESSAGE);
  }
  // The approved change is the connector's: its one entry goes to `to`.
  const group = connectorGroupId(server);
  if (old.allow || after?.tools?.[group]?.[tool] !== to) throw codedError(CONNECTOR_POLICY_WIDENS, NO_WIDEN_MESSAGE);
  if (connectorPolicyWidens(pinTool(old, group, tool), pinTool(after, group, tool))) {
    throw codedError(CONNECTOR_POLICY_WIDENS, NO_WIDEN_MESSAGE);
  }
  // No override: it asks at least (as connectorPolicyWidens reads it).
  const was = accountRank(old.tools, new Set(old.off), server, group, tool, 1);
  if (was < PERMISSION_RANK[from]) {
    throw codedError(CONNECTOR_TOOL_NARROWED, 'A newer restriction on this tool landed meanwhile; it was kept.');
  }
  if (was >= PERMISSION_RANK[to]) {
    throw codedError(CONNECTOR_TOOL_ALREADY, 'The tool already has this permission or more; nothing changed.');
  }
}

/** Throws NO_WIDEN_MESSAGE (code CONNECTOR_POLICY_WIDENS) when `after` could
 *  widen `before` (see connectorPolicyWidens); inside
 *  withApprovedConnectorToolChange, only its approved change may. */
export function assertConnectorPolicyNotWidened(before, after) {
  if (approvedToolChange) return assertApprovedToolChange(before, after, approvedToolChange);
  if (connectorPolicyWidens(before, after)) throw codedError(CONNECTOR_POLICY_WIDENS, NO_WIDEN_MESSAGE);
}

let toolPermissionWriter = null;
/** The host attaches the one writer of an agent's per-tool permission (the
 *  agent editor keeps every other agent.json key). */
export function setConnectorToolPermissionWriter(write) {
  toolPermissionWriter = typeof write === 'function' ? write : null;
}

/** Save `permission` for the connector tool `toolOrName` under `agentId`'s own
 *  policy. False when it is no connector tool or no writer is attached. */
export async function writeAgentMcpToolPermission(agentId, toolOrName, permission) {
  const mcp = parseMcpToolName(toolOrName);
  if (!toolPermissionWriter || !mcp || isSelfMcpToolName(toolOrName) || !CONNECTOR_PERMISSIONS.includes(permission)) {
    return false;
  }
  await toolPermissionWriter(agentId, mcp.server, mcp.tool, permission);
  return true;
}

/** The permission `agentId` has for the MCP tool `toolOrName`. */
export function agentMcpToolPermission(agentId, toolOrName) {
  if (!parseMcpToolName(toolOrName)) return 'auto';
  return connectorToolPermission(agentConnectors(agentId), toolOrName);
}

/** Where a session runs: its registered Project (a worktree Lead's too), and
 *  its cwd (a delegated worker inside the project). */
function sessionProjectPaths(session) {
  return [session?.desktopSession?.projectPath, session?.workspace?.projectPath, session?.cwd]
    .map(clean)
    .filter(Boolean);
}

/** True when the project `session` runs in switched the tool's connector off
 *  (or its policy file cannot be read). */
export function projectMcpToolDisabled(session, toolOrName, dataDir = resolvePluginData()) {
  const mcp = parseMcpToolName(toolOrName);
  if (!mcp || isSelfMcpToolName(toolOrName)) return false;
  const paths = sessionProjectPaths(session);
  if (!paths.length) return false;
  const policies = projectConnectorPolicies(dataDir);
  if (!policies) return false;
  if (policies === DENY_ALL_CONNECTORS) return true;
  return policies.some(
    ({ root, off }) => off.includes(mcp.server) && paths.some((path) => cwdWithinProjects(path, [root]))
  );
}
