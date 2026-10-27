import { createHmac, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
  canonicalizeStoredChannelsConfig,
  readSection,
  updateSection,
  updateSectionAsync,
} from '../../runtime/shared/config.mjs';
import { CHANNELS_DEFAULTS, stripChannelsDefaults } from '../../runtime/shared/defaults-separation.mjs';
import {
  listSchedules as dbListSchedules,
  getSchedule as dbGetSchedule,
  upsertSchedule,
  renameSchedule as dbRenameSchedule,
  deleteSchedule as dbDeleteSchedule,
  setEnabled as dbSetEnabled,
} from '../../runtime/channels/lib/schedules-db.mjs';
import {
  listEndpoints as dbListEndpoints,
  loadEndpointConfig as dbLoadEndpoint,
  readEndpointSecret as dbReadEndpointSecret,
  upsertEndpoint as dbUpsertEndpoint,
  deleteEndpoint as dbDeleteEndpoint,
  setEndpointEnabled as dbSetEndpointEnabled,
} from '../../runtime/channels/lib/webhooks-db.mjs';
import { normalizeAutomationAttachments } from '../../runtime/shared/automation-attachments.mjs';
import { assertRoutineOwner, routineOwnerProblem } from '../routine-owner.mjs';
import { hasEnabledAutomation } from '../../runtime/shared/automation-presence.mjs';
import { resolveScheduleTimezone, validateScheduleCron } from '../../runtime/shared/schedule-time.mjs';
import { scheduleNameTakenError, scheduleRenameRunningError } from '../../runtime/channels/lib/schedule-errors.mjs';
import { pgClusterExists } from '../../runtime/memory/lib/pg/adapter.mjs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';
import { readHookPublicBase } from '../../runtime/channels/lib/webhook/relay-tunnel.mjs';
import { WEBHOOK_TEST_FIELD, WEBHOOK_TEST_HEADER } from '../../runtime/channels/lib/webhook/request-handler.mjs';
import { MIXY_AGENT_ID, agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertName(name, kind = 'name') {
  const value = String(name || '').trim();
  if (!NAME_RE.test(value) || value !== basename(value)) {
    throw new Error(`${kind} must match ${NAME_RE}`);
  }
  return value;
}

// Schedules are PG-keyed display names, not URL/file identifiers like
// webhooks: allow Unicode letters/digits (e.g. Korean titles) plus space,
// dot, underscore, and hyphen. The basename() guard plus the character set
// keeps names path-safe for the legacy prompts-dir fallback.
const SCHEDULE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;
function assertScheduleName(name) {
  const value = String(name || '').trim();
  if (!SCHEDULE_NAME_RE.test(value) || value !== basename(value)) {
    throw new Error('schedule name must be 1-64 letters, digits, spaces, dots, underscores, or hyphens');
  }
  return value;
}

function normalizeChannelsConfig(raw = {}) {
  const stored = canonicalizeStoredChannelsConfig(raw);
  return {
    ...CHANNELS_DEFAULTS,
    ...stored,
    webhook: { ...CHANNELS_DEFAULTS.webhook, ...(stored.webhook || {}) },
  };
}

// Callers see the effective config (defaults filled in); the file keeps only
// values that differ from the defaults.
function persistedChannelsConfig(next) {
  return stripChannelsDefaults(normalizeChannelsConfig(next));
}

function updateChannelsSection(build) {
  let next;
  updateSection('channels', (current) => {
    // Writes converge on the single `channel` object.
    const normalized = normalizeChannelsConfig(current);
    next = build(normalized);
    return persistedChannelsConfig(next);
  });
  return next;
}

// Async twin of updateChannelsSection: identical normalize/strip logic, but the
// channels-section RMW runs through updateSectionAsync so a debounced settings
// flush does not block the event loop. Same config lock file → linearizable
// with the sync writers.
async function updateChannelsSectionAsync(build) {
  let next;
  await updateSectionAsync('channels', (current) => {
    const normalized = normalizeChannelsConfig(current);
    next = build(normalized);
    return persistedChannelsConfig(next);
  });
  return next;
}

// The sync and async webhook writers must apply the very same patch rules.
const webhookPatch = (patch) => (cfg) => ({
  ...cfg,
  webhook: {
    ...(cfg.webhook || {}),
    ...(Object.hasOwn(patch, 'enabled') ? { enabled: patch.enabled === true } : {}),
    ...(patch.port ? { port: Number(patch.port) || 3333 } : {}),
    ...(patch.domain ? { domain: String(patch.domain).trim() } : {}),
  },
});

export function setWebhookConfig(patch = {}) {
  return updateChannelsSection(webhookPatch(patch));
}

export async function setWebhookConfigAsync(patch = {}) {
  return updateChannelsSectionAsync(webhookPatch(patch));
}

function normalizeCron(time) {
  const value = String(time || '').trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error('time must be a 5- or 6-field cron expression');
  }
  return value;
}

// Day-name / keyword -> cron day-of-week number (Sun=0 .. Sat=6).
const DAY_TOKEN_TO_DOW = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

// Fold a legacy `days` selector into the day-of-week (last) field of a cron
// expression: daily -> '*', weekday -> '1-5', weekend -> '0,6', explicit day
// lists ("mon,wed,fri" | "1,3,5") -> comma-joined numbers. Throws on an
// unmappable token so bad combos surface instead of silently mis-scheduling.
function foldDaysIntoCron(cron, days) {
  const parts = String(cron).trim().split(/\s+/);
  const dowIndex = parts.length - 1;
  const raw = String(days || '')
    .trim()
    .toLowerCase();
  // days absent -> keep the cron's own day-of-week field ('0 9 * * 1' stays
  // Monday-only). Only an explicit selector rewrites the dow field.
  if (!raw) return parts.join(' ');
  let dow;
  if (raw === 'daily' || raw === 'everyday' || raw === 'every day') dow = '*';
  else if (raw === 'weekday' || raw === 'weekdays') dow = '1-5';
  else if (raw === 'weekend' || raw === 'weekends') dow = '0,6';
  else {
    const nums = raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((tok) => (/^[0-6]$/.test(tok) ? Number(tok) : DAY_TOKEN_TO_DOW[tok]));
    if (nums.some((n) => n === undefined)) {
      throw new Error(`days "${days}" is not a recognizable day selector`);
    }
    dow = nums.join(',');
  }
  parts[dowIndex] = dow;
  return parts.join(' ');
}

function parseAtDatetime(at) {
  const raw = String(at || '').trim();
  if (!raw) throw new Error('at must be a datetime');
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`at "${at}" is not a valid datetime`);
  return d;
}

// Map the store's def shape onto the flat display shape every schedule reader
// (channelSetup, renderChannelStatus, TUI pickers) consumes: `.time` renders
// the cron or the one-shot datetime.
function scheduleToDisplay(s, ownerProblem = '') {
  return {
    name: s.name,
    description: s.description || '',
    time: s.whenCron || (s.whenAt ? `at ${new Date(s.whenAt).toISOString()}` : ''),
    whenAt: s.whenAt || undefined,
    whenCron: s.whenCron || undefined,
    timezone: s.timezone || undefined,
    cwd: s.cwd || undefined,
    attachments: s.attachments || undefined,
    enabled: s.enabled !== false,
    instructions: s.prompt,
    // The bot it belongs to: each run is a turn in that bot's chat.
    owner: s.ownerAgentId || MIXY_AGENT_ID,
    // Why it is paused for its owner (routine-owner.mjs); absent when it runs.
    ...(ownerProblem ? { ownerProblem } : {}),
    nextFireAt: isoOrUndefined(s.nextFireAt),
    lastSuccessAt: isoOrUndefined(s.lastSuccessAt),
    lastFailedAt: isoOrUndefined(s.lastFailedAt),
    lastSkippedAt: isoOrUndefined(s.lastSkippedAt),
    ...routineHealth(s),
  };
}

// Failures in a row (the routine pauses itself at the limit) and the results
// of finished runs still not queued for the owner: `{ count, failed, error }`,
// `failed` when the queue refused one (the app offers a retry).
function routineHealth(row) {
  const entries = Object.values(row.resultDelivery || {}).filter(Boolean);
  const refused = entries.filter((entry) => entry.state === 'failed').at(-1);
  return {
    consecutiveFailures: Number(row.consecutiveFailures) || 0,
    ...(entries.length
      ? {
          undelivered: {
            count: entries.length,
            failed: Boolean(refused),
            ...(refused?.error ? { error: String(refused.error) } : {}),
          },
        }
      : {}),
  };
}

function isoOrUndefined(value) {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

// A schedule's or webhook's owner: an explicit agent id, else the saved owner
// on an overwrite, else Mixy.
function scheduleOwner(owner, existing) {
  const value = String(owner ?? '').trim();
  if (value) {
    if (!agentHomeSessionId(value)) throw new Error(`schedule owner "${value}" is not a valid agent id`);
    return value;
  }
  return existing?.ownerAgentId || MIXY_AGENT_ID;
}

/** Each owner's problem (routine-owner.mjs) for its stored rows, probed once
 *  per owner. */
function ownerProblems() {
  const seen = new Map();
  return (ownerAgentId) => {
    const owner = ownerAgentId || MIXY_AGENT_ID;
    if (!seen.has(owner))
      seen.set(
        owner,
        routineOwnerProblem(owner, null, { stored: true }).catch(() => '')
      );
    return seen.get(owner);
  };
}

export async function listSchedules() {
  const rows = await dbListSchedules();
  const problemOf = ownerProblems();
  return Promise.all(rows.map(async (row) => scheduleToDisplay(row, await problemOf(row.ownerAgentId))));
}

/**
 * Run `step` (the move of schedule `name`'s row) with `name` reserved against
 * runs in this process (the app's "Run now"). Refused when one is in flight.
 */
export async function withScheduleRenameReserved(name, step) {
  const { beginAutomationRename } = await import('../owned-automation-run.mjs');
  const release = beginAutomationRename('schedule', name);
  if (!release) throw scheduleRenameRunningError(name);
  try {
    return await step();
  } finally {
    release();
  }
}

// Whether `next` fires when `existing` does: the same cron in the same zone (a
// stored row without a zone runs in the default one, as the scheduler arms
// it), or the same instant, whatever its spelling.
function sameTiming(existing, next) {
  const instant = (value) => (value ? new Date(value).getTime() : null);
  if ((existing.whenCron || null) !== next.whenCron) return false;
  if (next.whenCron && resolveScheduleTimezone(existing.timezone) !== next.timezone) return false;
  return instant(existing.whenAt) === instant(next.whenAt);
}

// The rename when no channels worker owns the scheduler: this process's runs
// are the only ones there are.
export const renameScheduleHere = (oldName, def, opts) =>
  withScheduleRenameReserved(oldName, () => dbRenameSchedule(oldName, def, opts));

// Register or update a schedule in the PG store. Recurring input maps `time`
// (+ optional `days`) to a cron; one-shot input maps an `at` datetime; the two
// are mutually exclusive (also enforced by the store's when_at/when_cron XOR).
// Every schedule runs as a turn in its owner bot's chat; a bot that does not
// exist (no representative bot yet, an archived bot) cannot own one.
export async function saveSchedule(
  {
    name,
    description = '',
    time,
    at,
    timezone,
    days,
    cwd,
    attachments,
    enabled,
    instructions,
    owner,
    overwrite = false,
    newName,
  } = {},
  { rename = renameScheduleHere } = {}
) {
  const id = assertScheduleName(name);
  const renameTo = newName != null && String(newName).trim() !== '' ? assertScheduleName(newName) : id;
  const renaming = renameTo !== id;
  const body = String(instructions || '').trim();
  if (!body) throw new Error('schedule instructions are required');
  const hasTime = time != null && String(time).trim() !== '';
  const hasAt = at != null && String(at).trim() !== '';
  if (hasTime && hasAt) throw new Error('provide either `time` (recurring) or `at` (one-shot), not both');
  if (!hasTime && !hasAt) throw new Error('either `time` (recurring cron) or `at` (one-shot datetime) is required');
  const existing = await dbGetSchedule(id);
  if (renaming && !existing) throw new Error(`schedule "${id}" does not exist`);
  if (overwrite !== true && existing) {
    throw scheduleNameTakenError(id);
  }
  const ownerAgentId = scheduleOwner(owner, existing);
  await assertRoutineOwner(ownerAgentId);
  const whenCron = hasTime ? validateScheduleCron(foldDaysIntoCron(normalizeCron(time), days)) : null;
  const whenAt = hasAt ? parseAtDatetime(at) : null;
  const scheduleTimezone = hasTime ? resolveScheduleTimezone(timezone) : null;
  const def = {
    name: renameTo,
    description: String(description || '').trim(),
    whenCron,
    whenAt,
    timezone: scheduleTimezone,
    cwd: cwd ? String(cwd).trim() : null,
    attachments: normalizeAutomationAttachments(attachments),
    delivery: 'app',
    prompt: body,
    enabled: enabled !== false,
    nextFireAt: whenAt,
    ownerAgentId,
  };
  let saved;
  if (renaming) {
    if (await dbGetSchedule(renameTo)) throw scheduleNameTakenError(renameTo);
    const timingChanged = !sameTiming(existing, { whenCron, whenAt, timezone: scheduleTimezone });
    saved = await rename(id, def, { timingChanged });
    if (!saved) throw new Error(`schedule "${id}" does not exist`);
  } else {
    saved = await upsertSchedule(def);
  }
  automationProbe.invalidate();
  return scheduleToDisplay(saved);
}

export async function deleteSchedule(name) {
  const id = assertScheduleName(name);
  await dbDeleteSchedule(id);
  automationProbe.invalidate();
  return { name: id, deleted: true };
}

export async function setScheduleEnabled(name, enabled) {
  const id = assertScheduleName(name);
  const updated = await dbSetEnabled(id, enabled !== false);
  automationProbe.invalidate();
  if (!updated) throw new Error(`schedule "${id}" does not exist`);
  return { name: id, enabled: enabled !== false };
}

// Webhook endpoints are stored in the PG table `webhooks.endpoints`
// (webhooks-db.mjs) — the single source of truth. Legacy per-endpoint
// WEBHOOK.md + secret folders are imported once at boot and deleted by the
// store's migration hook.
async function listWebhooks() {
  const endpoints = await dbListEndpoints();
  const problemOf = ownerProblems();
  const problems = await Promise.all(endpoints.map((ep) => problemOf(ep.ownerAgentId)));
  return endpoints.map((ep, index) => ({
    name: ep.name,
    description: ep.description || '',
    parser: ep.parser || 'github',
    ...(ep.cwd ? { cwd: ep.cwd } : {}),
    ...(ep.attachments ? { attachments: ep.attachments } : {}),
    enabled: ep.enabled,
    // The store never projects the plaintext secret through list paths; it
    // exposes a presence flag (secretSet) instead.
    secretSet: ep.secretSet === true,
    secret: undefined,
    instructions: ep.instructions,
    // The bot it belongs to: each run is a turn in that bot's chat.
    owner: ep.ownerAgentId || MIXY_AGENT_ID,
    ...(problems[index] ? { ownerProblem: problems[index] } : {}),
    lastEventAt: isoOrUndefined(ep.lastEventAt),
    lastSuccessAt: isoOrUndefined(ep.lastSuccessAt),
    lastFailedAt: isoOrUndefined(ep.lastFailedAt),
    lastSkippedAt: isoOrUndefined(ep.lastSkippedAt),
    // Whether "Run now" has a received payload to re-run (never the payload).
    hasLastPayload: ep.hasLastPayload === true,
    ...routineHealth(ep),
  }));
}

export async function saveWebhook({
  name,
  description = '',
  parser = 'github',
  secret,
  cwd,
  attachments,
  enabled,
  instructions,
  owner,
  overwrite = false,
} = {}) {
  const id = assertName(name, 'webhook name');
  const nextParser = String(parser || 'github')
    .trim()
    .toLowerCase();
  if (!['github', 'generic', 'stripe', 'sentry'].includes(nextParser)) {
    throw new Error('parser must be github, generic, stripe, or sentry');
  }
  const body = String(instructions || '').trim();
  if (!body) throw new Error('webhook instructions are required');
  const existing = await dbLoadEndpoint(id);
  if (overwrite !== true && existing) {
    throw new Error(`webhook "${id}" already exists`);
  }
  const ownerAgentId = scheduleOwner(owner, existing);
  await assertRoutineOwner(ownerAgentId);
  // Secret semantics: an explicit value always wins; an EMPTY value on an
  // overwrite PRESERVES the stored secret (editing instructions must not
  // silently rotate the key the external service was configured with); only
  // a brand-new endpoint mints a random secret.
  const secretValue =
    String(secret || '').trim() ||
    (overwrite === true ? String((await dbReadEndpointSecret(id)) || '').trim() : '') ||
    randomBytes(24).toString('hex');
  const saved = await dbUpsertEndpoint({
    name: id,
    description: String(description || '').trim(),
    parser: nextParser,
    cwd: cwd ? String(cwd).trim() : null,
    attachments: normalizeAutomationAttachments(attachments),
    delivery: 'app',
    secret: secretValue,
    instructions: body,
    enabled: enabled !== false,
    ownerAgentId,
  });
  automationProbe.invalidate();
  return {
    name: id,
    owner: saved.ownerAgentId || ownerAgentId,
    description: saved.description,
    parser: saved.parser,
    ...(saved.cwd ? { cwd: saved.cwd } : {}),
    ...(saved.attachments ? { attachments: saved.attachments } : {}),
    ...(enabled === false ? { enabled: false } : {}),
    secret: secretValue,
    instructions: body,
  };
}

export async function deleteWebhook(name) {
  const id = assertName(name, 'webhook name');
  await dbDeleteEndpoint(id);
  automationProbe.invalidate();
  return { name: id, deleted: true };
}

export async function setWebhookEnabled(name, enabled) {
  const id = assertName(name, 'webhook name');
  const updated = await dbSetEndpointEnabled(id, enabled !== false);
  automationProbe.invalidate();
  if (!updated) throw new Error(`webhook "${id}" does not exist`);
  return { name: id, enabled: enabled !== false };
}

// Explicit single-purpose secret read (the list path only ever exposes a
// presence flag). The desktop editor never calls it: a saved secret is only
// replaced via Regenerate. Not exposed over the remote bridge.
export async function getWebhookSecret(name) {
  const id = assertName(name, 'webhook name');
  return { name: id, secret: (await dbReadEndpointSecret(id)) || '' };
}

// Sends a correctly signed, test-flagged request to the endpoint's real public
// URL. The receiver verifies the signature and answers without dispatching.
// Failures carry a stable `code` (relay-unavailable | timeout | network |
// rejected) for localized UI text; `error` stays the English detail.
export async function testWebhook(name) {
  const id = assertName(name, 'webhook name');
  const endpoint = await dbLoadEndpoint(id);
  if (!endpoint) throw new Error(`webhook "${id}" does not exist`);
  const secret = (await dbReadEndpointSecret(id)) || '';
  const base = String(readHookPublicBase() || '').replace(/\/+$/, '');
  if (!base) {
    return {
      name: id,
      ok: false,
      status: 0,
      url: '',
      code: 'relay-unavailable',
      error: 'Endpoint URL is not available yet — the relay is not connected.',
    };
  }
  const url = `${base}/webhook/${encodeURIComponent(id)}`;
  const body = JSON.stringify({ [WEBHOOK_TEST_FIELD]: true, webhook: id, sentAt: new Date().toISOString() });
  const parser = endpoint.parser || 'github';
  const hmac = (data) => createHmac('sha256', secret).update(data).digest('hex');
  const headers = {
    'content-type': 'application/json',
    [WEBHOOK_TEST_HEADER]: '1',
  };
  if (parser === 'stripe') {
    const t = Math.floor(Date.now() / 1000);
    headers['stripe-signature'] = `t=${t},v1=${hmac(`${t}.${body}`)}`;
  } else if (parser === 'sentry') {
    headers['sentry-hook-signature'] = hmac(body);
  } else if (parser === 'generic') {
    headers['x-signature-256'] = `sha256=${hmac(body)}`;
  } else {
    headers['x-hub-signature-256'] = `sha256=${hmac(body)}`;
    headers['x-github-event'] = 'ping';
  }
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    // Body read stays inside the try: a timeout while reading is a timeout,
    // only an unparsable body falls back to "no JSON".
    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    const ok = res.status === 200 && json?.status === 'verified';
    const result = { name: id, ok, status: res.status, url };
    if (!ok) {
      result.code = 'rejected';
      result.error = json?.error ? String(json.error) : `Unexpected response (HTTP ${res.status})`;
    }
    return result;
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      name: id,
      ok: false,
      status: 0,
      url,
      code: timedOut ? 'timeout' : 'network',
      error: timedOut ? 'Request timed out after 15 seconds.' : String(err?.message || err),
    };
  }
}

// Automation presence: any enabled schedule or webhook endpoint. Drives the
// worker boot decision — schedules and webhooks run sessions, so they must
// not require an explicit remote toggle.
async function checkActiveAutomation() {
  const { schedules, webhooks } = await readAutomationRows();
  return hasEnabledAutomation({ schedules, webhooks });
}

// Read-only views (channel setup, the automation probe) never bring
// PostgreSQL up for the first time: before initdb ran no schedule or webhook
// can exist, and that first start — runtime download/extract plus initdb — is
// seconds of work no catalog read should wait on. Writes still start it.
async function readAutomationRows() {
  if (!pgClusterExists(resolvePluginData())) return { schedules: [], webhooks: [] };
  const [schedules, webhooks] = await Promise.all([listSchedules(), listWebhooks()]);
  return { schedules, webhooks };
}

// Every session runtime in the process asks this at boot. Concurrent callers
// join one in-flight check and a settled answer is reused for ttlMs, so N
// runtimes booting together cost one PG query (and at most one PG boot)
// instead of N. Automation writes through this module invalidate the answer
// at once; writes from other processes are picked up after ttlMs. A failed
// check (e.g. PG still booting) answers false to its callers but is never
// reused, so the next runtime checks again.
const AUTOMATION_PROBE_TTL_MS = 60_000;

export function createAutomationProbe(check, { ttlMs = AUTOMATION_PROBE_TTL_MS, now = Date.now } = {}) {
  let pending = null;
  let answer = null;
  let settledAt = 0;
  let generation = 0;
  return {
    probe() {
      if (pending) return pending;
      if (answer !== null && now() - settledAt < ttlMs) return Promise.resolve(answer);
      const startedGeneration = generation;
      const current = Promise.resolve()
        .then(check)
        .then(
          (active) => ({ active: active === true, settled: true }),
          () => ({ active: false, settled: false })
        )
        .then(({ active, settled }) => {
          if (startedGeneration === generation) {
            if (settled) {
              answer = active;
              settledAt = now();
            }
            pending = null;
          }
          return active;
        });
      pending = current;
      return current;
    },
    invalidate() {
      generation += 1;
      pending = null;
      answer = null;
    },
  };
}

const automationProbe = createAutomationProbe(checkActiveAutomation);

export function hasActiveAutomation() {
  return automationProbe.probe();
}

// The daemon opens both stores in the background once ready (it settles
// hasActiveAutomation), so on an existing cluster this read joins a
// PostgreSQL start already under way instead of being the one that starts it.
export async function channelSetup(config = null) {
  const cfg = normalizeChannelsConfig(config || readSection('channels'));
  const { schedules, webhooks } = await readAutomationRows();
  return {
    webhook: {
      ...(cfg.webhook || {}),
      // Relay-tunnel public base (null until the channel worker first
      // connects and mints its hook identity).
      publicUrl: readHookPublicBase(),
    },
    schedules,
    webhooks,
  };
}
