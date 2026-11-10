// session/human-gate/store.mjs
// Per-agent permissions and the decision audit, both under the plugin data dir.
// A grant is keyed by agent + action kind (outbound-policy.mjs ACTION_KINDS)
// and says `allow` (never ask: "다시 묻지 않기") or `block` (deny without a
// card); no grant means ask. `agent` scope names the agent, `always` stands for
// every agent ('*'), and an agent's own grant wins over an every-agent one;
// `once` is never stored, and neither is `session` (an in-memory allowance for
// one session: session-grants.mjs). Payments and deletes are never allowed. Grants are
// listed and revoked by id. A hook ask on a tool no action kind covers is keyed
// `tool:<name>` (outbound-policy.mjs toolActionOf): only ever an every-agent
// `allow`, shown in each agent's table as a shared row, and turned back to
// asking by the same revoke ("ask") as any other. The audit is one JSONL line per decision with
// agent, kind, action, tool, target, decision, deciding device and time —
// never a value, an argument or a payload — read back newest first.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJsonState, updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { ACTION_KINDS, isRememberableAction, isToolAction } from './outbound-policy.mjs';

const ANY_AGENT = '*';
const FIELD_LIMIT = 200;
const AUDIT_KEYS = ['agentId', 'kind', 'action', 'tool', 'target', 'decision', 'device'];
export const PERMISSION_MODES = Object.freeze(['ask', 'allow', 'block']);

const field = (value) => String(value ?? '').slice(0, FIELD_LIMIT);
const grantId = (agentId, action) =>
  `grant_${createHash('sha256').update(`${agentId}\n${action}`).digest('hex').slice(0, 24)}`;
const MODE_RANK = Object.freeze({ block: 0, ask: 1, allow: 2 });
export const NO_WIDEN_MESSAGE = 'This change would widen what the bot may do without asking; make it on the desktop.';
const isKnownAction = (action) => ACTION_KINDS.includes(action) || isToolAction(action);
const isGrant = (row) =>
  isKnownAction(row?.action) &&
  (isToolAction(row.action)
    ? row.mode === 'allow' && row.agentId === ANY_AGENT
    : row.mode === 'allow' || row.mode === 'block');

/** The row deciding `agentId`'s mode: its own grant, else the every-agent one
 *  (`sharedOnly`: only the every-agent one). */
function decidingGrant(grants, agentId, action, sharedOnly = false) {
  const rows = grants.filter((grant) => grant.action === action);
  const shared = rows.find((grant) => grant.agentId === ANY_AGENT);
  return sharedOnly ? shared : rows.find((grant) => grant.agentId === agentId) || shared;
}

/** The effective mode among `grants`: the agent's own grant, else an every-agent one. */
function effectiveMode(grants, agentId, action, sharedOnly = false) {
  const own = decidingGrant(grants, agentId, action, sharedOnly);
  if (own?.mode === 'allow' && !isRememberableAction(action)) return 'ask';
  return own?.mode || 'ask';
}

export function createHumanGateStore(directory) {
  const grantsFile = join(directory, 'grants.json');
  const auditFile = join(directory, 'audit.jsonl');
  const grantsOf = (doc) => (Array.isArray(doc?.grants) ? doc.grants.filter(isGrant) : []);
  // A damaged file (empty, NUL, torn) is kept aside by readJsonState and reads
  // as no grants: every action asks again, never "allowed". No `.bak` is ever
  // written or restored (`restoreBackup: false`, also for a stale one left by
  // an older build) — an older copy could bring back a revoked allow.
  const readGrants = async () => grantsOf(await readJsonState(grantsFile, { fallback: null, restoreBackup: false }));
  async function updateGrants(mutate) {
    await mkdir(directory, { recursive: true });
    let result;
    await updateJsonAtomic(
      grantsFile,
      (doc) => {
        const out = mutate(grantsOf(doc));
        if (!out) return undefined;
        result = out.result;
        return { grants: out.grants };
      },
      { restoreBackup: false }
    );
    return result;
  }
  /** Set `agentId`'s mode for `action`; `ask` removes its grant — and, when it
   *  has none of its own, the every-agent allow its mode came from (a shared
   *  row listed in its table is turned back to asking for everyone). Returns
   *  the grant, or null for `ask` and for an `allow` that may not exist. */
  async function setMode({ agentId, action, mode, device = '', noWiden = false }) {
    if (!isKnownAction(action) || !PERMISSION_MODES.includes(mode)) return null;
    if (mode === 'allow' && !isRememberableAction(action)) return null;
    const owner = field(agentId);
    // A tool is only ever allowed for every agent, and never blocked.
    if (isToolAction(action) && (mode === 'block' || (mode === 'allow' && owner !== ANY_AGENT))) return null;
    const id = grantId(owner, action);
    const sharedId = grantId(ANY_AGENT, action);
    const grant = mode === 'ask' ? null : { id, agentId: owner, action, mode, device: field(device), at: Date.now() };
    await updateGrants((grants) => {
      const dropsShared =
        mode === 'ask' &&
        owner !== ANY_AGENT &&
        !grants.some((row) => row.id === id) &&
        grants.some((row) => row.id === sharedId && row.mode === 'allow');
      const next = [
        ...grants.filter((row) => row.id !== id && !(dropsShared && row.id === sharedId)),
        ...(grant ? [grant] : []),
      ];
      // `noWiden` (a remote client's call): judged on the effective mode inside the
      // same locked read-modify-write, so a block landing meanwhile is never lifted.
      if (noWiden && MODE_RANK[effectiveMode(next, owner, action)] > MODE_RANK[effectiveMode(grants, owner, action)]) {
        throw new Error(NO_WIDEN_MESSAGE);
      }
      return { grants: next, result: grant };
    });
    return grant;
  }
  /** `allow`, `block` or `ask` for `agentId` + `action`; the agent's own grant
   *  wins. `sharedOnly` reads only the every-agent grant (a "this agent" allow
   *  made for another purpose is then not looked at). */
  async function modeFor({ agentId, action, sharedOnly = false }) {
    return effectiveMode(await readGrants(), agentId, action, sharedOnly);
  }
  return {
    setMode,
    modeFor,
    /** Stores an `allow` for `agent`/`always` scope; `once` stores nothing.
     *  A tool key takes `always` only. Returns the grant or null. */
    async grant({ agentId, action, scope, device = '' }) {
      if (scope !== 'agent' && scope !== 'always') return null;
      return setMode({ agentId: scope === 'always' ? ANY_AGENT : agentId, action, mode: 'allow', device });
    },
    /** Every action kind with `agentId`'s mode, for the profile's permission
     *  table, then one row per tool allowed for every agent. `shared` marks a
     *  row whose allow is the every-agent one. */
    async permissions(agentId) {
      const grants = await readGrants();
      const out = ACTION_KINDS.map((action) => {
        const mode = effectiveMode(grants, agentId, action);
        const shared = mode === 'allow' && decidingGrant(grants, agentId, action)?.agentId === ANY_AGENT;
        return { action, mode, rememberable: isRememberableAction(action), ...(shared ? { shared: true } : {}) };
      });
      for (const grant of grants) {
        if (isToolAction(grant.action)) {
          out.push({ action: grant.action, mode: 'allow', rememberable: true, shared: true });
        }
      }
      return out;
    },
    /** Grants that apply to `agentId` (its own and every-agent ones); all when omitted. */
    async listGrants({ agentId } = {}) {
      const grants = await readGrants();
      return agentId ? grants.filter((grant) => grant.agentId === agentId || grant.agentId === ANY_AGENT) : grants;
    },
    async revokeGrant(id) {
      return (
        (await updateGrants((grants) => {
          const rest = grants.filter((grant) => grant.id !== id);
          return rest.length === grants.length ? null : { grants: rest, result: true };
        })) === true
      );
    },
    async recordAudit(entry) {
      const line = { at: Number.isFinite(entry?.at) ? entry.at : Date.now() };
      for (const key of AUDIT_KEYS) line[key] = field(entry?.[key]);
      await mkdir(dirname(auditFile), { recursive: true });
      await appendFile(auditFile, `${JSON.stringify(line)}\n`, 'utf8');
      return line;
    },
    /** Newest first; `agentId` filters to one agent. */
    async readAudit({ agentId = '', limit = 100 } = {}) {
      let raw = '';
      try {
        raw = await readFile(auditFile, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const rows = [];
      for (const line of raw.split('\n').reverse()) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (!agentId || row.agentId === agentId) rows.push(row);
        } catch {}
        if (rows.length >= limit) break;
      }
      return rows;
    },
  };
}

let processStore = null;
/** The process store under the plugin data dir; built on first use. */
export async function humanGateStore() {
  if (!processStore) {
    const { getPluginData } = await import('../../config.mjs');
    processStore = createHumanGateStore(join(getPluginData(), 'human-gate'));
  }
  return processStore;
}

function requiredAgentId(agentId) {
  if (typeof agentId !== 'string' || !agentId.trim() || agentId.length > FIELD_LIMIT || agentId === ANY_AGENT) {
    throw new Error('agent id is invalid');
  }
  return agentId;
}

/** The profile's "권한" table for `agentId` (capability getAgentPermissions). */
export async function agentPermissions(agentId) {
  return (await humanGateStore()).permissions(requiredAgentId(agentId));
}

/** Set one row of that table (capability setAgentPermission); returns the table. */
export async function setAgentPermission(agentId, action, mode, options) {
  const agent = requiredAgentId(agentId);
  if (!isKnownAction(action)) throw new Error(`action must be one of ${ACTION_KINDS.join(', ')}`);
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`mode must be one of ${PERMISSION_MODES.join(', ')}`);
  if (mode === 'allow' && !isRememberableAction(action)) throw new Error(`${action} always asks; it cannot be allowed`);
  // A tool is allowed from its approval card only; here it can only be turned back to asking.
  if (isToolAction(action) && mode !== 'ask') throw new Error(`${action} can only be set back to ask`);
  const store = await humanGateStore();
  await store.setMode({ agentId: agent, action, mode, noWiden: options?.noWiden === true });
  return store.permissions(agent);
}

/** The audit decision of a call the "Allow all actions" developer option let through unasked. */
export const DEV_ALLOW_ALL_DECISION = 'dev-allow-all';
/** The audit decisions of "allow for this session": the allowance was made
 *  (session-grants.mjs), and it later let a call run unasked. They parallel
 *  `granted` / `remembered` of a saved "always allow". */
export const SESSION_GRANTED_DECISION = 'session-granted';
export const SESSION_REMEMBERED_DECISION = 'session-remembered';

const BROWSER_AUDIT_DECISIONS = Object.freeze([
  'approve',
  'deny',
  'granted',
  'remembered',
  SESSION_GRANTED_DECISION,
  SESSION_REMEMBERED_DECISION,
  'run-allowed',
  'blocked',
  DEV_ALLOW_ALL_DECISION,
]);

/** Audit one Browser Use approval of a bot (capability recordAgentApprovalAudit):
 *  the bot, the action kind and what happened — `approve` / `deny` for the card,
 *  `granted` when "always allow" was saved, `remembered` when a saved allow let
 *  a step run unasked, `session-granted` / `session-remembered` for the same
 *  of "allow for this session", `dev-allow-all` when the developer option did.
 *  Never a page address, target or value. */
export async function recordAgentApprovalAudit(agentId, action, decision) {
  const agent = requiredAgentId(agentId);
  if (!ACTION_KINDS.includes(action)) throw new Error(`action must be one of ${ACTION_KINDS.join(', ')}`);
  if (!BROWSER_AUDIT_DECISIONS.includes(decision)) {
    throw new Error(`decision must be one of ${BROWSER_AUDIT_DECISIONS.join(', ')}`);
  }
  await (await humanGateStore()).recordAudit({ agentId: agent, kind: 'browser', action, tool: 'browser', decision });
  return null;
}

/** Replace the process store (tests); null restores the default. */
export function setHumanGateStore(store) {
  processStore = store || null;
}
