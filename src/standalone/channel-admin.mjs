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
  getWebhookAuthtoken,
  hasStoredSecret,
  readSection,
  saveSecret,
  updateSection,
} from '../runtime/shared/config.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_CHANNELS = Object.freeze({
  backend: 'discord',
  discord: {},
  access: { dmPolicy: 'allowlist', allowFrom: [], channels: {} },
  mainChannel: 'main',
  channelsConfig: {
    main: { channelId: '', mode: 'interactive' },
  },
  quiet: { schedule: '23:00-09:00', holidays: false },
  schedules: { respectQuiet: true },
  webhook: { enabled: true, respectQuiet: false, port: 3333 },
});

function dataDir() {
  return resolvePluginData();
}

function schedulesDir() {
  return join(dataDir(), 'schedules');
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

// Serialize a single-file frontmatter markdown document:
//   ---
//   key: value
//   ---
//
//   <body>
// Values are stringified as-is (enabled:false -> "false"); the reader casts
// types back. Mirrors the WORKFLOW.md / SKILL.md single-file convention.
function serializeFrontmatterDoc(meta = {}, body = '') {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n${String(body || '').trim()}\n`;
}

function assertName(name, kind = 'name') {
  const value = String(name || '').trim();
  if (!NAME_RE.test(value) || value !== basename(value)) {
    throw new Error(`${kind} must match ${NAME_RE}`);
  }
  return value;
}

function normalizeChannelsConfig(raw = {}) {
  return {
    ...DEFAULT_CHANNELS,
    ...(raw && typeof raw === 'object' ? raw : {}),
    discord: { ...DEFAULT_CHANNELS.discord, ...(raw?.discord || {}) },
    access: { ...DEFAULT_CHANNELS.access, ...(raw?.access || {}) },
    channelsConfig: { ...DEFAULT_CHANNELS.channelsConfig, ...(raw?.channelsConfig || {}) },
    quiet: { ...DEFAULT_CHANNELS.quiet, ...(raw?.quiet || {}) },
    schedules: { ...DEFAULT_CHANNELS.schedules, ...(raw?.schedules || {}) },
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

function updateChannelsSection(build) {
  let next;
  updateSection('channels', (current) => {
    next = build(normalizeChannelsConfig(current));
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

export function listChannels(config = {}) {
  const cfg = normalizeChannelsConfig(config);
  const backend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
  return Object.entries(cfg.channelsConfig || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      name,
      channelId: channelIdForBackend(value, backend),
      discordChannelId: String(value?.discordChannelId || ''),
      telegramChatId: String(value?.telegramChatId || ''),
      mode: value?.mode || 'interactive',
      main: cfg.mainChannel === name,
    }));
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

export function saveWebhookAuthtoken(token) {
  const value = String(token || '').trim();
  if (!value) throw new Error('Webhook/ngrok authtoken is required');
  saveSecret(SECRET_ACCOUNTS.webhookAuth, value);
  return { ok: true, configured: Boolean(getWebhookAuthtoken()) };
}

export function forgetWebhookAuthtoken() {
  deleteSecret(SECRET_ACCOUNTS.webhookAuth);
  return { ok: true };
}

export function saveChannel({ name, channelId, mode = 'interactive', main = false, backend = null } = {}) {
  const label = assertName(name, 'channel name');
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');
  const nextMode = mode === 'broadcast' ? 'broadcast' : 'interactive';
  const targetBackend = backend === 'telegram' || backend === 'discord' ? backend : null;
  return updateChannelsSection((cfg) => {
    const activeBackend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
    const current = seedBackendChannelIds(cfg.channelsConfig?.[label] || {}, activeBackend);
    const nextEntry = { ...current, mode: nextMode };
    if (targetBackend === 'telegram') nextEntry.telegramChatId = id;
    else if (targetBackend === 'discord') nextEntry.discordChannelId = id;
    else nextEntry.channelId = id;
    nextEntry.channelId = targetBackend
      ? (channelIdForBackend(nextEntry, activeBackend) || (targetBackend === activeBackend ? id : ''))
      : id;
    return {
      ...cfg,
      mainChannel: main || !cfg.mainChannel ? label : cfg.mainChannel,
      channelsConfig: {
        ...(cfg.channelsConfig || {}),
        [label]: nextEntry,
      },
    };
  });
}

export function deleteChannel(name) {
  const label = assertName(name, 'channel name');
  return updateChannelsSection((cfg) => {
    const channelsConfig = { ...(cfg.channelsConfig || {}) };
    delete channelsConfig[label];
    const nextMain = cfg.mainChannel === label ? Object.keys(channelsConfig)[0] || 'main' : cfg.mainChannel;
    return { ...cfg, channelsConfig, mainChannel: nextMain };
  });
}

export function setWebhookConfig(patch = {}) {
  return updateChannelsSection((cfg) => ({
    ...cfg,
    webhook: {
      ...(cfg.webhook || {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'enabled') ? { enabled: patch.enabled === true } : {}),
      ...(Object.prototype.hasOwnProperty.call(patch, 'respectQuiet') ? { respectQuiet: patch.respectQuiet === true } : {}),
      ...(patch.port ? { port: Number(patch.port) || 3333 } : {}),
      ...(patch.domain ? { domain: String(patch.domain).trim() } : {}),
      ...(patch.ngrokDomain ? { ngrokDomain: String(patch.ngrokDomain).trim() } : {}),
    },
  }));
}

export function setBackend(name) {
  const value = String(name || '').trim();
  if (value !== 'discord' && value !== 'telegram') {
    throw new Error('backend must be discord or telegram');
  }
  updateChannelsSection((cfg) => {
    const activeBackend = cfg.backend === 'telegram' ? 'telegram' : 'discord';
    const channelsConfig = Object.fromEntries(Object.entries(cfg.channelsConfig || {}).map(([key, entry]) => [
      key,
      (() => {
        const seeded = seedBackendChannelIds(entry, activeBackend);
        return { ...seeded, channelId: channelIdForBackend(seeded, value) };
      })(),
    ]));
    return { ...cfg, channelsConfig, backend: value };
  });
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

export function listSchedules() {
  return listEntryDirs(schedulesDir()).map((name) => {
    const dir = join(schedulesDir(), name);
    const { frontmatter, body } = readMarkdownDocument(readText(join(dir, 'SCHEDULE.md'), ''));
    const config = { ...frontmatter };
    if (Object.prototype.hasOwnProperty.call(config, 'enabled')) {
      config.enabled = config.enabled !== 'false' && config.enabled !== false;
    }
    return {
      name,
      ...config,
      instructions: body,
      route: config.channel ? `channel:${config.channel}` : 'session',
    };
  });
}

export function saveSchedule({
  name,
  time,
  timezone,
  days,
  channel,
  model,
  enabled,
  instructions,
  overwrite = false,
} = {}) {
  const id = assertName(name, 'schedule name');
  const cron = normalizeCron(time);
  const body = String(instructions || '').trim();
  if (!body) throw new Error('schedule instructions are required');
  if (channel && !model) throw new Error('model is required when channel is set');
  const dir = join(schedulesDir(), id);
  if (existsSync(dir) && overwrite !== true) throw new Error(`schedule "${id}" already exists`);
  mkdirSync(dir, { recursive: true });
  const config = { time: cron };
  if (timezone) config.timezone = String(timezone).trim();
  if (days && days !== 'daily') config.days = String(days).trim();
  if (channel) config.channel = String(channel).trim();
  if (model) config.model = String(model).trim();
  if (enabled === false) config.enabled = false;
  writeTextAtomic(join(dir, 'SCHEDULE.md'), serializeFrontmatterDoc(config, body));
  return { name: id, ...config, instructions: body };
}

export function deleteSchedule(name) {
  const id = assertName(name, 'schedule name');
  rmSync(join(schedulesDir(), id), { recursive: true, force: true });
  return { name: id, deleted: true };
}

export function setScheduleEnabled(name, enabled) {
  const id = assertName(name, 'schedule name');
  const dir = join(schedulesDir(), id);
  const mdPath = join(dir, 'SCHEDULE.md');
  if (!existsSync(mdPath)) throw new Error(`schedule "${id}" does not exist`);
  const { frontmatter, body } = readMarkdownDocument(readText(mdPath, ''));
  writeTextAtomic(mdPath, serializeFrontmatterDoc({ ...frontmatter, enabled: enabled !== false }, body));
  return { name: id, enabled: enabled !== false };
}

export function listWebhooks() {
  return listEntryDirs(webhooksDir()).map((name) => {
    const dir = join(webhooksDir(), name);
    const { frontmatter, body } = readMarkdownDocument(readText(join(dir, 'WEBHOOK.md'), ''));
    const config = { ...frontmatter };
    if (Object.prototype.hasOwnProperty.call(config, 'enabled')) {
      config.enabled = config.enabled !== 'false' && config.enabled !== false;
    }
    // Secret lives in a side file (<name>/secret), never in frontmatter, so
    // an arbitrary user-supplied secret (quotes/colon/newline) round-trips
    // losslessly and setWebhookEnabled cannot corrupt it.
    const hasSecret = Boolean(readText(join(dir, 'secret'), '').trim());
    return {
      name,
      ...config,
      secretSet: hasSecret,
      secret: undefined,
      instructions: body,
      route: config.channel ? `channel:${config.channel}` : 'session',
    };
  });
}

export function saveWebhook({
  name,
  parser = 'github',
  secret,
  channel,
  model,
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
  const dir = join(webhooksDir(), id);
  if (existsSync(dir) && overwrite !== true) throw new Error(`webhook "${id}" already exists`);
  mkdirSync(dir, { recursive: true });
  const secretValue = String(secret || randomBytes(24).toString('hex')).trim();
  const config = { parser: nextParser };
  if (channel) config.channel = String(channel).trim();
  if (model) config.model = String(model).trim();
  if (enabled === false) config.enabled = false;
  // Secret to a side file (plaintext, same exposure level as the former
  // config.json), kept OUT of the frontmatter to avoid unquote round-trip
  // corruption. deleteWebhook rmSync's the whole dir, so this is removed too.
  writeTextAtomic(join(dir, 'secret'), secretValue + '\n');
  writeTextAtomic(join(dir, 'WEBHOOK.md'), serializeFrontmatterDoc(config, body));
  return { name: id, ...config, secret: secretValue, instructions: body };
}

export function deleteWebhook(name) {
  const id = assertName(name, 'webhook name');
  rmSync(join(webhooksDir(), id), { recursive: true, force: true });
  return { name: id, deleted: true };
}

export function setWebhookEnabled(name, enabled) {
  const id = assertName(name, 'webhook name');
  const dir = join(webhooksDir(), id);
  const mdPath = join(dir, 'WEBHOOK.md');
  if (!existsSync(mdPath)) throw new Error(`webhook "${id}" does not exist`);
  const { frontmatter, body } = readMarkdownDocument(readText(mdPath, ''));
  writeTextAtomic(mdPath, serializeFrontmatterDoc({ ...frontmatter, enabled: enabled !== false }, body));
  return { name: id, enabled: enabled !== false };
}

export function channelSetup(config = null) {
  const cfg = normalizeChannelsConfig(config || readSection('channels'));
  const discordToken = getDiscordToken();
  const discordProblem = diagnoseDiscordTokenValue(discordToken, cfg);
  const webhookAuth = getWebhookAuthtoken();
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
      authenticated: Boolean(webhookAuth),
      stored: hasStoredSecret(SECRET_ACCOUNTS.webhookAuth),
      status: webhookAuth ? 'Set' : 'Off',
    },
    channels: listChannels(cfg),
    schedules: listSchedules(),
    webhooks: listWebhooks(),
  };
}

export function renderChannelStatus(config = null) {
  const setup = channelSetup(config);
  const lines = [];
  lines.push(`discord  ${setup.discord.status}${setup.discord.problem ? ` (${setup.discord.problem})` : ''}`);
  lines.push(`webhook  ${setup.webhook.enabled === false ? 'disabled' : 'enabled'} · auth ${setup.webhook.status} · port ${setup.webhook.port || 3333}`);
  lines.push('channels');
  if (setup.channels.length === 0) lines.push('  (none)');
  for (const ch of setup.channels) {
    lines.push(`  ${ch.name}${ch.main ? ' *' : ''}  ${ch.channelId || '(unset)'}  ${ch.mode}`);
  }
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
