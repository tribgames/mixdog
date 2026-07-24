import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  SECRET_ACCOUNTS,
  deleteSecret,
  diagnoseDiscordTokenValue,
  getDiscordToken,
  getTelegramToken,
  hasStoredSecret,
  readSection,
  saveSecret,
  updateSection,
  updateSectionAsync,
} from '../runtime/shared/config.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { readMarkdownDocument, serializeFrontmatterDoc } from '../runtime/shared/markdown-frontmatter.mjs';
import {
  listSchedules as dbListSchedules,
  getSchedule as dbGetSchedule,
  upsertSchedule,
  deleteSchedule as dbDeleteSchedule,
  setEnabled as dbSetEnabled,
} from '../runtime/shared/schedules-db.mjs';
import {
  listEndpoints as dbListEndpoints,
  loadEndpointConfig as dbLoadEndpoint,
  readEndpointSecret as dbReadEndpointSecret,
  upsertEndpoint as dbUpsertEndpoint,
  deleteEndpoint as dbDeleteEndpoint,
  setEndpointEnabled as dbSetEndpointEnabled,
} from '../runtime/shared/webhooks-db.mjs';
import { readHookPublicBase } from '../runtime/channels/lib/webhook/relay-tunnel.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_CHANNELS = Object.freeze({
  backend: 'discord',
  discord: {},
  access: { dmPolicy: 'allowlist', allowFrom: [], channels: {} },
  channel: { channelId: '', discordChannelId: '', telegramChatId: '' },
  webhook: { enabled: true, port: 3333 },
});

function dataDir() {
  return resolvePluginData();
}

function webhooksDir() {
  return join(dataDir(), 'webhooks');
}

function readText(path, fallback = '') {
  try { return readFileSync(path, 'utf8'); } catch { return fallback; }
}

function writeTextAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, String(text ?? ''), 'utf8');
  renameSync(tmp, path);
}

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
  return {
    ...DEFAULT_CHANNELS,
    ...(raw && typeof raw === 'object' ? raw : {}),
    discord: { ...DEFAULT_CHANNELS.discord, ...(raw?.discord || {}) },
    access: { ...DEFAULT_CHANNELS.access, ...(raw?.access || {}) },
    channel: { ...DEFAULT_CHANNELS.channel, ...(raw?.channel || {}) },
    webhook: { ...DEFAULT_CHANNELS.webhook, ...(raw?.webhook || {}) },
  };
}

function channelIdForBackend(entry = {}, backend = 'discord') {
  if (backend === 'telegram') {
    return String(entry?.telegramChatId || (entry?.discordChannelId ? '' : entry?.channelId) || '');
  }
  return String(entry?.discordChannelId || (entry?.telegramChatId ? '' : entry?.channelId) || '');
}

function seedBackendChannelIds(entry = {}, backend = 'discord') {
  const next = { ...(entry || {}) };
  if (next.channelId) {
    if (backend === 'telegram' && !next.telegramChatId && !next.discordChannelId) next.telegramChatId = next.channelId;
    if (backend !== 'telegram' && !next.discordChannelId && !next.telegramChatId) next.discordChannelId = next.channelId;
  }
  return next;
}

// Resolve the single-channel entry from the config's `channel` object.
function resolveChannelEntry(cfg = {}) {
  if (cfg.channel && typeof cfg.channel === 'object'
    && (cfg.channel.channelId || cfg.channel.discordChannelId || cfg.channel.telegramChatId)) {
    return cfg.channel;
  }
  return cfg.channel && typeof cfg.channel === 'object' ? cfg.channel : {};
}

function updateChannelsSection(build) {
  let next;
  updateSection('channels', (current) => {
    // Writes converge on the single `channel` object.
    const normalized = normalizeChannelsConfig(current);
    next = build(normalized);
    return normalizeChannelsConfig(next);
  });
  return next;
}

// Async twin of updateChannelsSection: identical normalize/strip logic, but the
// channels-section RMW runs through updateSectionAsync so a debounced backend
// flush does not block the event loop. Same config lock file → linearizable
// with the sync writers.
async function updateChannelsSectionAsync(build) {
  let next;
  await updateSectionAsync('channels', (current) => {
    const normalized = normalizeChannelsConfig(current);
    next = build(normalized);
    return normalizeChannelsConfig(next);
  });
  return next;
}

function listEntryDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Single-channel read: resolves `cfg.channel` into the flat shape the
// settings/TUI layer consumes.
function getChannel(config = {}) {
  const cfg = normalizeChannelsConfig(config);
  const backend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
  const entry = resolveChannelEntry(cfg);
  return {
    channelId: channelIdForBackend(entry, backend),
    discordChannelId: String(entry?.discordChannelId || ''),
    telegramChatId: String(entry?.telegramChatId || ''),
  };
}

export function saveDiscordToken(token) {
  const value = String(token || '').trim();
  if (!value) throw new Error('Discord bot token is required');
  saveSecret(SECRET_ACCOUNTS.discordToken, value);
  return { ok: true, configured: Boolean(getDiscordToken()) };
}

export function forgetDiscordToken() {
  deleteSecret(SECRET_ACCOUNTS.discordToken);
  return { ok: true };
}

export function saveTelegramToken(token) {
  const value = String(token || '').trim();
  if (!value) throw new Error('Telegram bot token is required');
  saveSecret(SECRET_ACCOUNTS.telegramToken, value);
  return { ok: true, configured: Boolean(getTelegramToken()) };
}

export function forgetTelegramToken() {
  deleteSecret(SECRET_ACCOUNTS.telegramToken);
  return { ok: true };
}

// Single-channel write: persists `cfg.channel`, keeping the per-backend id
// fields (discordChannelId/telegramChatId) so a backend switch retains both
// ids. `backend` selects which per-backend field the id updates; when omitted
// the id lands on the active backend's field.
export function setChannel({ channelId, backend = null } = {}) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');
  const targetBackend = backend === 'telegram' || backend === 'discord' ? backend : null;
  return updateChannelsSection((cfg) => {
    const activeBackend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
    const writeBackend = targetBackend || activeBackend;
    const current = seedBackendChannelIds(resolveChannelEntry(cfg), activeBackend);
    const nextEntry = { ...current };
    if (writeBackend === 'telegram') nextEntry.telegramChatId = id;
    else nextEntry.discordChannelId = id;
    // `channelId` mirrors the active backend's id for legacy readers.
    nextEntry.channelId = channelIdForBackend(nextEntry, activeBackend);
    return { ...cfg, channel: nextEntry };
  });
}

export async function setChannelAsync({ channelId, backend = null } = {}) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');
  const targetBackend = backend === 'telegram' || backend === 'discord' ? backend : null;
  return updateChannelsSectionAsync((cfg) => {
    const activeBackend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
    const writeBackend = targetBackend || activeBackend;
    const current = seedBackendChannelIds(resolveChannelEntry(cfg), activeBackend);
    const nextEntry = { ...current };
    if (writeBackend === 'telegram') nextEntry.telegramChatId = id;
    else nextEntry.discordChannelId = id;
    nextEntry.channelId = channelIdForBackend(nextEntry, activeBackend);
    return { ...cfg, channel: nextEntry };
  });
}

export function setWebhookConfig(patch = {}) {
  return updateChannelsSection((cfg) => ({
    ...cfg,
    webhook: {
      ...(cfg.webhook || {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'enabled') ? { enabled: patch.enabled === true } : {}),
      ...(patch.port ? { port: Number(patch.port) || 3333 } : {}),
      ...(patch.domain ? { domain: String(patch.domain).trim() } : {}),
    },
  }));
}

export async function setWebhookConfigAsync(patch = {}) {
  return updateChannelsSectionAsync((cfg) => ({
    ...cfg,
    webhook: {
      ...(cfg.webhook || {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'enabled') ? { enabled: patch.enabled === true } : {}),
      ...(patch.port ? { port: Number(patch.port) || 3333 } : {}),
      ...(patch.domain ? { domain: String(patch.domain).trim() } : {}),
    },
  }));
}

function validateBackend(name) {
  const value = String(name || '').trim();
  if (value !== 'discord' && value !== 'telegram') {
    throw new Error('backend must be discord or telegram');
  }
  return value;
}
function backendBuilder(value) {
  return (cfg) => {
    const activeBackend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
    const seeded = seedBackendChannelIds(resolveChannelEntry(cfg), activeBackend);
    // `channelId` now mirrors the newly-selected backend's id; both per-backend
    // id fields are retained so switching back keeps the other id.
    const channel = { ...seeded, channelId: channelIdForBackend(seeded, value) };
    return { ...cfg, channel, backend: value };
  };
}
export function setBackend(name) {
  const value = validateBackend(name);
  updateChannelsSection(backendBuilder(value));
  return { ok: true, backend: value };
}
// Async twin used by the debounced backend-save flush timer.
export async function setBackendAsync(name) {
  const value = validateBackend(name);
  await updateChannelsSectionAsync(backendBuilder(value));
  return { ok: true, backend: value };
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
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Fold a legacy `days` selector into the day-of-week (last) field of a cron
// expression: daily -> '*', weekday -> '1-5', weekend -> '0,6', explicit day
// lists ("mon,wed,fri" | "1,3,5") -> comma-joined numbers. Throws on an
// unmappable token so bad combos surface instead of silently mis-scheduling.
function foldDaysIntoCron(cron, days) {
  const parts = String(cron).trim().split(/\s+/);
  const dowIndex = parts.length - 1;
  const raw = String(days || '').trim().toLowerCase();
  // days absent -> keep the cron's own day-of-week field ('0 9 * * 1' stays
  // Monday-only). Only an explicit selector rewrites the dow field.
  if (!raw) return parts.join(' ');
  let dow;
  if (raw === 'daily' || raw === 'everyday' || raw === 'every day') dow = '*';
  else if (raw === 'weekday' || raw === 'weekdays') dow = '1-5';
  else if (raw === 'weekend' || raw === 'weekends') dow = '0,6';
  else {
    const nums = raw.split(/[\s,]+/).filter(Boolean).map((tok) => (
      /^[0-6]$/.test(tok) ? Number(tok) : DAY_TOKEN_TO_DOW[tok]
    ));
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
    channel: s.channelId || undefined,
    model: s.model || undefined,
    cwd: s.cwd || undefined,
    workflow: s.workflow || undefined,
    enabled: s.enabled !== false,
    instructions: s.prompt,
    route: s.target === 'channel' ? `channel:${s.channelId}` : 'session',
  };
}

export async function listSchedules() {
  const rows = await dbListSchedules();
  return rows.map(scheduleToDisplay);
}

// Register or update a schedule in the PG store. Recurring input maps `time`
// (+ optional `days`) to a cron; one-shot input maps an `at` datetime; the two
// are mutually exclusive (also enforced by the store's when_at/when_cron XOR).
// `channel` selects a channel target (model required); otherwise session.
export async function saveSchedule({
  name,
  description = '',
  time,
  at,
  timezone,
  days,
  channel,
  model,
  cwd,
  workflow,
  enabled,
  instructions,
  overwrite = false,
} = {}) {
  const id = assertScheduleName(name);
  const body = String(instructions || '').trim();
  if (!body) throw new Error('schedule instructions are required');
  if (channel && !model) throw new Error('model is required when channel is set');
  const hasTime = time != null && String(time).trim() !== '';
  const hasAt = at != null && String(at).trim() !== '';
  if (hasTime && hasAt) throw new Error('provide either `time` (recurring) or `at` (one-shot), not both');
  if (!hasTime && !hasAt) throw new Error('either `time` (recurring cron) or `at` (one-shot datetime) is required');
  if (overwrite !== true && (await dbGetSchedule(id))) {
    throw new Error(`schedule "${id}" already exists`);
  }
  const whenCron = hasTime ? foldDaysIntoCron(normalizeCron(time), days) : null;
  const whenAt = hasAt ? parseAtDatetime(at) : null;
  const saved = await upsertSchedule({
    name: id,
    description: String(description || '').trim(),
    whenCron,
    whenAt,
    timezone: timezone ? String(timezone).trim() : null,
    target: channel ? 'channel' : 'session',
    channelId: channel ? String(channel).trim() : null,
    model: model ? String(model).trim() : null,
    cwd: cwd ? String(cwd).trim() : null,
    workflow: workflow ? String(workflow).trim() : null,
    prompt: body,
    enabled: enabled !== false,
  });
  return scheduleToDisplay(saved);
}

export async function deleteSchedule(name) {
  const id = assertScheduleName(name);
  await dbDeleteSchedule(id);
  return { name: id, deleted: true };
}

export async function setScheduleEnabled(name, enabled) {
  const id = assertScheduleName(name);
  const updated = await dbSetEnabled(id, enabled !== false);
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
    ...(ep.channelId ? { channel: ep.channelId } : {}),
    ...(ep.model ? { model: ep.model } : {}),
    ...(ep.cwd ? { cwd: ep.cwd } : {}),
    ...(ep.workflow ? { workflow: ep.workflow } : {}),
    enabled: ep.enabled,
    // The store never projects the plaintext secret through list paths; it
    // exposes a presence flag (secretSet) instead.
    secretSet: ep.secretSet === true,
    secret: undefined,
    instructions: ep.instructions,
    route: ep.channelId ? `channel:${ep.channelId}` : 'session',
  }));
}

export async function saveWebhook({
  name,
  description = '',
  parser = 'github',
  secret,
  channel,
  model,
  cwd,
  workflow,
  enabled,
  instructions,
  overwrite = false,
} = {}) {
  const id = assertName(name, 'webhook name');
  const nextParser = String(parser || 'github').trim().toLowerCase();
  if (!['github', 'generic', 'stripe', 'sentry'].includes(nextParser)) {
    throw new Error('parser must be github, generic, stripe, or sentry');
  }
  const body = String(instructions || '').trim();
  if (!body) throw new Error('webhook instructions are required');
  if (channel && !model) throw new Error('model is required when channel is set');
  if (overwrite !== true && (await dbLoadEndpoint(id))) {
    throw new Error(`webhook "${id}" already exists`);
  }
  // Secret semantics: an explicit value always wins; an EMPTY value on an
  // overwrite PRESERVES the stored secret (editing instructions must not
  // silently rotate the key the external service was configured with); only
  // a brand-new endpoint mints a random secret.
  const secretValue = String(secret || '').trim()
    || (overwrite === true ? String((await dbReadEndpointSecret(id)) || '').trim() : '')
    || randomBytes(24).toString('hex');
  const saved = await dbUpsertEndpoint({
    name: id,
    description: String(description || '').trim(),
    parser: nextParser,
    channelId: channel ? String(channel).trim() : null,
    model: model ? String(model).trim() : null,
    cwd: cwd ? String(cwd).trim() : null,
    workflow: workflow ? String(workflow).trim() : null,
    secret: secretValue,
    instructions: body,
    enabled: enabled !== false,
  });
  return {
    name: id,
    description: saved.description,
    parser: saved.parser,
    ...(saved.channelId ? { channel: saved.channelId } : {}),
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.cwd ? { cwd: saved.cwd } : {}),
    ...(saved.workflow ? { workflow: saved.workflow } : {}),
    ...(enabled === false ? { enabled: false } : {}),
    secret: secretValue,
    instructions: body,
  };
}

export async function deleteWebhook(name) {
  const id = assertName(name, 'webhook name');
  await dbDeleteEndpoint(id);
  return { name: id, deleted: true };
}

export async function setWebhookEnabled(name, enabled) {
  const id = assertName(name, 'webhook name');
  const updated = await dbSetEndpointEnabled(id, enabled !== false);
  if (!updated) throw new Error(`webhook "${id}" does not exist`);
  return { name: id, enabled: enabled !== false };
}

// Explicit single-purpose secret read for the editor's copy affordance (the
// list path only ever exposes a presence flag). Local surfaces only — the
// desktop blocks this capability over the remote bridge.
export async function getWebhookSecret(name) {
  const id = assertName(name, 'webhook name');
  return { name: id, secret: (await dbReadEndpointSecret(id)) || '' };
}

// Automation presence: any enabled schedule or webhook endpoint. Drives the
// worker boot decision independently of the messaging channels — schedules
// and webhooks run sessions, so they must not require Discord/Telegram
// tokens or an explicit remote toggle.
export async function hasActiveAutomation() {
  try {
    const [schedules, webhooks] = await Promise.all([listSchedules(), listWebhooks()]);
    return schedules.some((entry) => entry?.enabled !== false && entry?.status !== 'done')
      || webhooks.some((entry) => entry?.enabled !== false);
  } catch {
    return false;
  }
}

export async function channelSetup(config = null) {
  const cfg = normalizeChannelsConfig(config || readSection('channels'));
  const discordToken = getDiscordToken();
  const discordProblem = diagnoseDiscordTokenValue(discordToken, cfg);
  const telegramToken = getTelegramToken();
  return {
    backend: cfg.backend || 'discord',
    discord: {
      backend: 'discord',
      authenticated: Boolean(discordToken && !discordProblem),
      stored: hasStoredSecret(SECRET_ACCOUNTS.discordToken),
      status: discordToken ? (discordProblem ? 'Invalid' : 'Set') : 'Off',
      problem: discordProblem || null,
    },
    telegram: {
      backend: 'telegram',
      authenticated: Boolean(telegramToken),
      stored: hasStoredSecret(SECRET_ACCOUNTS.telegramToken),
      status: telegramToken ? 'Set' : 'Off',
      problem: null,
    },
    webhook: {
      ...(cfg.webhook || {}),
      // Relay-tunnel public base (null until the channel worker first
      // connects and mints its hook identity).
      publicUrl: readHookPublicBase(),
    },
    channel: getChannel(cfg),
    schedules: await listSchedules(),
    webhooks: await listWebhooks(),
  };
}

async function renderChannelStatus(config = null) {
  const setup = await channelSetup(config);
  const lines = [];
  lines.push(`discord  ${setup.discord.status}${setup.discord.problem ? ` (${setup.discord.problem})` : ''}`);
  lines.push(`webhook  ${setup.webhook.enabled === false ? 'disabled' : 'enabled'} · port ${setup.webhook.port || 3333}${setup.webhook.publicUrl ? ` · ${setup.webhook.publicUrl}` : ''}`);
  lines.push(`channel  ${setup.channel.channelId || '(unset)'}`);
  lines.push('schedules');
  if (setup.schedules.length === 0) lines.push('  (none)');
  for (const item of setup.schedules) {
    lines.push(`  ${item.name}  ${item.time || '(no cron)'}  ${item.route}${item.model ? `  ${item.model}` : ''}`);
  }
  lines.push('webhooks');
  if (setup.webhooks.length === 0) lines.push('  (none)');
  for (const item of setup.webhooks) {
    lines.push(`  ${item.name}  ${item.parser || 'github'}  ${item.route}${item.model ? `  ${item.model}` : ''}  secret:${item.secretSet ? 'set' : 'missing'}`);
  }
  return lines.join('\n');
}
