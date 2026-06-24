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
  getWebhookAuthtoken,
  hasStoredSecret,
  readSection,
  saveSecret,
  updateSection,
} from '../runtime/shared/config.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

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

function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
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

function writeJsonAtomic(path, data) {
  writeTextAtomic(path, JSON.stringify(data, null, 2) + '\n');
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
  return Object.entries(cfg.channelsConfig || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      name,
      channelId: String(value?.channelId || ''),
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

export function saveChannel({ name, channelId, mode = 'interactive', main = false } = {}) {
  const label = assertName(name, 'channel name');
  const id = String(channelId || '').trim();
  if (!id) throw new Error('channelId is required');
  const nextMode = mode === 'broadcast' ? 'broadcast' : 'interactive';
  return updateChannelsSection((cfg) => ({
    ...cfg,
    mainChannel: main || !cfg.mainChannel ? label : cfg.mainChannel,
    channelsConfig: {
      ...(cfg.channelsConfig || {}),
      [label]: { ...(cfg.channelsConfig?.[label] || {}), channelId: id, mode: nextMode },
    },
  }));
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
    const config = readJson(join(dir, 'config.json'), {});
    const instructions = readText(join(dir, 'instructions.md'), '');
    return {
      name,
      ...config,
      instructions,
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
  writeJsonAtomic(join(dir, 'config.json'), config);
  writeTextAtomic(join(dir, 'instructions.md'), body + '\n');
  return { name: id, ...config, instructions: body };
}

export function deleteSchedule(name) {
  const id = assertName(name, 'schedule name');
  rmSync(join(schedulesDir(), id), { recursive: true, force: true });
  return { name: id, deleted: true };
}

export function listWebhooks() {
  return listEntryDirs(webhooksDir()).map((name) => {
    const dir = join(webhooksDir(), name);
    const config = readJson(join(dir, 'config.json'), {});
    const instructions = readText(join(dir, 'instructions.md'), '');
    return {
      name,
      ...config,
      secretSet: Boolean(config.secret),
      secret: undefined,
      instructions,
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
  const config = {
    secret: String(secret || randomBytes(24).toString('hex')).trim(),
    parser: nextParser,
  };
  if (channel) config.channel = String(channel).trim();
  if (model) config.model = String(model).trim();
  writeJsonAtomic(join(dir, 'config.json'), config);
  writeTextAtomic(join(dir, 'instructions.md'), body + '\n');
  return { name: id, ...config, instructions: body };
}

export function deleteWebhook(name) {
  const id = assertName(name, 'webhook name');
  rmSync(join(webhooksDir(), id), { recursive: true, force: true });
  return { name: id, deleted: true };
}

export function channelSetup(config = null) {
  const cfg = normalizeChannelsConfig(config || readSection('channels'));
  const discordToken = getDiscordToken();
  const discordProblem = diagnoseDiscordTokenValue(discordToken, cfg);
  const webhookAuth = getWebhookAuthtoken();
  return {
    discord: {
      backend: 'discord',
      authenticated: Boolean(discordToken && !discordProblem),
      stored: hasStoredSecret(SECRET_ACCOUNTS.discordToken),
      status: discordToken ? (discordProblem ? 'Invalid' : 'Set') : 'Off',
      problem: discordProblem || null,
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
