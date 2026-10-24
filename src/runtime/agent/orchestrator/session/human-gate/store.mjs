// session/human-gate/store.mjs
// Per-agent permissions and the decision audit, both under the plugin data dir.
// A grant is keyed by agent + action kind (outbound-policy.mjs ACTION_KINDS)
// and says `allow` (never ask: "다시 묻지 않기") or `block` (deny without a
// card); no grant means ask. `agent` scope names the agent, `always` stands for
// every agent ('*'), and an agent's own grant wins over an every-agent one;
// `once` is never stored. Payments and deletes are never allowed. Grants are
// listed and revoked by id. The audit is one JSONL line per decision with
// agent, kind, action, tool, target, decision, deciding device and time —
// never a value, an argument or a payload — read back newest first.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJsonState, updateJsonAtomic } from '../../../../shared/atomic-file.mjs';
import { ACTION_KINDS, isRememberableAction } from './outbound-policy.mjs';

const ANY_AGENT = '*';
const FIELD_LIMIT = 200;
const AUDIT_KEYS = ['agentId', 'kind', 'action', 'tool', 'target', 'decision', 'device'];
const PERMISSION_MODES = Object.freeze(['ask', 'allow', 'block']);

const field = (value) => String(value ?? '').slice(0, FIELD_LIMIT);
const grantId = (agentId, action) =>
  `grant_${createHash('sha256').update(`${agentId}\n${action}`).digest('hex').slice(0, 24)}`;
const MODE_RANK = Object.freeze({ block: 0, ask: 1, allow: 2 });
export const NO_WIDEN_MESSAGE = 'This change would widen what the bot may do without asking; make it on the desktop.';
const isGrant = (row) => ACTION_KINDS.includes(row?.action) && (row.mode === 'allow' || row.mode === 'block');

/** The effective mode among `grants`: the agent's own grant, else an every-agent one. */
function effectiveMode(grants, agentId, action) {
  const rows = grants.filter((grant) => grant.action === action);
  const own = rows.find((grant) => grant.agentId === agentId) || rows.find((grant) => grant.agentId === ANY_AGENT);
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
  /** Set `agentId`'s mode for `action`; `ask` removes its grant. Returns the
   *  grant, or null for `ask` and for an `allow` that may not exist. */
  async function setMode({ agentId, action, mode, device = '', noWiden = false }) {
    if (!ACTION_KINDS.includes(action) || !PERMISSION_MODES.includes(mode)) return null;
    if (mode === 'allow' && !isRememberableAction(action)) return null;
    const owner = field(agentId);
    const id = grantId(owner, action);
    const grant = mode === 'ask' ? null : { id, agentId: owner, action, mode, device: field(device), at: Date.now() };
    await updateGrants((grants) => {
      const next = [...grants.filter((row) => row.id !== id), ...(grant ? [grant] : [])];
      // `noWiden` (a remote client's call): judged on the effective mode inside the
      // same locked read-modify-write, so a block landing meanwhile is never lifted.
      if (noWiden && MODE_RANK[effectiveMode(next, owner, action)] > MODE_RANK[effectiveMode(grants, owner, action)]) {
        throw new Error(NO_WIDEN_MESSAGE);
      }
      return { grants: next, result: grant };
    });
    return grant;
  }
  /** `allow`, `block` or `ask` for `agentId` + `action`; the agent's own grant wins. */
  async function modeFor({ agentId, action }) {
    return effectiveMode(await readGrants(), agentId, action);
  }
  return {
    setMode,
    modeFor,
    /** Stores an `allow` for `agent`/`always` scope; `once` stores nothing. Returns the grant or null. */
    async grant({ agentId, action, scope, device = '' }) {
      if (scope !== 'agent' && scope !== 'always') return null;
      return setMode({ agentId: scope === 'always' ? ANY_AGENT : agentId, action, mode: 'allow', device });
    },
    /** Every action kind with `agentId`'s mode, for the profile's permission table. */
    async permissions(agentId) {
      const out = [];
      for (const action of ACTION_KINDS) {
        out.push({ action, mode: await modeFor({ agentId, action }), rememberable: isRememberableAction(action) });
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
  if (!ACTION_KINDS.includes(action)) throw new Error(`action must be one of ${ACTION_KINDS.join(', ')}`);
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`mode must be one of ${PERMISSION_MODES.join(', ')}`);
  if (mode === 'allow' && !isRememberableAction(action)) throw new Error(`${action} always asks; it cannot be allowed`);
  const store = await humanGateStore();
  await store.setMode({ agentId: agent, action, mode, noWiden: options?.noWiden === true });
  return store.permissions(agent);
}

/** The audit decision of a call the "Allow all actions" developer option let through unasked. */
export const DEV_ALLOW_ALL_DECISION = 'dev-allow-all';

const BROWSER_AUDIT_DECISIONS = Object.freeze([
  'approve',
  'deny',
  'granted',
  'remembered',
  'run-allowed',
  'blocked',
  DEV_ALLOW_ALL_DECISION,
]);

/** Audit one Browser Use approval of a bot (capability recordAgentApprovalAudit):
 *  the bot, the action kind and what happened — `approve` / `deny` for the card,
 *  `granted` when "always allow" was saved, `remembered` when a saved allow let
 *  a step run unasked, `dev-allow-all` when the developer option did. Never a
 *  page address, target or value. */
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
