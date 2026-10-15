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
import { migrateCodexModelRef } from '../../runtime/agent/orchestrator/providers/openai-oauth-catalog-store.mjs';
import { hasEnabledAutomation } from '../../runtime/shared/automation-presence.mjs';
import { resolveScheduleTimezone, validateScheduleCron } from '../../runtime/shared/schedule-time.mjs';
import { pgClusterExists } from '../../runtime/memory/lib/pg/adapter.mjs';
import { resolvePluginData } from '../../runtime/shared/plugin-paths.mjs';
import { readHookPublicBase } from '../../runtime/channels/lib/webhook/relay-tunnel.mjs';
import { WEBHOOK_TEST_FIELD, WEBHOOK_TEST_HEADER } from '../../runtime/channels/lib/webhook/request-handler.mjs';

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
    access: { ...CHANNELS_DEFAULTS.access, ...(stored.access || {}) },
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
// the cron or the one-shot datetime, `.route` the channel/session target.
function scheduleToDisplay(s) {
  return {
    name: s.name,
    description: s.description || '',
    time: s.whenCron || (s.whenAt ? `at ${new Date(s.whenAt).toISOString()}` : ''),
    whenAt: s.whenAt || undefined,
    whenCron: s.whenCron || undefined,
    timezone: s.timezone || undefined,
    // Shown (and re-saved by the editor) on the catalog successor of a superseded model.
    model: s.model ? migrateCodexModelRef(s.model) : undefined,
    cwd: s.cwd || undefined,
    workflow: s.workflow || undefined,
    attachments: s.attachments || undefined,
    enabled: s.enabled !== false,
    instructions: s.prompt,
    route: 'session',
  };
}

export async function listSchedules() {
  const rows = await dbListSchedules();
  return rows.map(scheduleToDisplay);
}

// Register or update a schedule in the PG store. Recurring input maps `time`
// (+ optional `days`) to a cron; one-shot input maps an `at` datetime; the two
// are mutually exclusive (also enforced by the store's when_at/when_cron XOR).
// Every schedule runs as a visible app session and requires a model.
export async function saveSchedule({
  name,
  description = '',
  time,
  at,
  timezone,
  days,
  model,
  cwd,
  workflow,
  attachments,
  enabled,
  instructions,
  overwrite = false,
} = {}) {
  const id = assertScheduleName(name);
  const body = String(instructions || '').trim();
  if (!body) throw new Error('schedule instructions are required');
  const scheduleModel = String(model || '').trim();
  if (!scheduleModel) throw new Error('schedule model is required — choose a model before saving');
  const hasTime = time != null && String(time).trim() !== '';
  const hasAt = at != null && String(at).trim() !== '';
  if (hasTime && hasAt) throw new Error('provide either `time` (recurring) or `at` (one-shot), not both');
  if (!hasTime && !hasAt) throw new Error('either `time` (recurring cron) or `at` (one-shot datetime) is required');
  if (overwrite !== true && (await dbGetSchedule(id))) {
    throw new Error(`schedule "${id}" already exists`);
  }
  const whenCron = hasTime ? validateScheduleCron(foldDaysIntoCron(normalizeCron(time), days)) : null;
  const whenAt = hasAt ? parseAtDatetime(at) : null;
  const scheduleTimezone = hasTime ? resolveScheduleTimezone(timezone) : null;
  const saved = await upsertSchedule({
    name: id,
    description: String(description || '').trim(),
    whenCron,
    whenAt,
    timezone: scheduleTimezone,
    target: 'session',
    channelId: null,
    model: scheduleModel,
    cwd: cwd ? String(cwd).trim() : null,
    workflow: workflow ? String(workflow).trim() : null,
    attachments: normalizeAutomationAttachments(attachments),
    delivery: 'app',
    prompt: body,
    enabled: enabled !== false,
    nextFireAt: whenAt,
  });
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
  return endpoints.map((ep) => ({
    name: ep.name,
    description: ep.description || '',
    parser: ep.parser || 'github',
    ...(ep.model ? { model: migrateCodexModelRef(ep.model) } : {}),
    ...(ep.cwd ? { cwd: ep.cwd } : {}),
    ...(ep.workflow ? { workflow: ep.workflow } : {}),
    ...(ep.attachments ? { attachments: ep.attachments } : {}),
    enabled: ep.enabled,
    // The store never projects the plaintext secret through list paths; it
    // exposes a presence flag (secretSet) instead.
    secretSet: ep.secretSet === true,
    secret: undefined,
    instructions: ep.instructions,
    route: 'session',
  }));
}

export async function saveWebhook({
  name,
  description = '',
  parser = 'github',
  secret,
  model,
  cwd,
  workflow,
  attachments,
  enabled,
  instructions,
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
  if (overwrite !== true && (await dbLoadEndpoint(id))) {
    throw new Error(`webhook "${id}" already exists`);
  }
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
    channelId: null,
    model: model ? String(model).trim() : null,
    cwd: cwd ? String(cwd).trim() : null,
    workflow: workflow ? String(workflow).trim() : null,
    attachments: normalizeAutomationAttachments(attachments),
    delivery: 'app',
    secret: secretValue,
    instructions: body,
    enabled: enabled !== false,
  });
  automationProbe.invalidate();
  return {
    name: id,
    description: saved.description,
    parser: saved.parser,
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.cwd ? { cwd: saved.cwd } : {}),
    ...(saved.workflow ? { workflow: saved.workflow } : {}),
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
// worker boot decision independently of the messaging channels — schedules
// and webhooks run sessions, so they must not require Discord/Telegram
// tokens or an explicit remote toggle.
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
export const AUTOMATION_PROBE_TTL_MS = 60_000;

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
