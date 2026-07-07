import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DiscordBackend } from "../backends/discord.mjs";
import { TelegramBackend } from "../backends/telegram.mjs";
import { readSection, updateSection, CONFIG_PATH as MIXDOG_CONFIG_PATH, getDiscordToken, getTelegramToken, diagnoseDiscordTokenValue } from "../../shared/config.mjs";
import { listSchedules } from "../../shared/schedules-db.mjs";
import { resolvePluginData } from "../../shared/plugin-paths.mjs";
const DATA_DIR = resolvePluginData();
const CONFIG_FILE = MIXDOG_CONFIG_PATH;
const DEFAULT_ACCESS = {
  dmPolicy: "allowlist",
  allowFrom: [],
  channels: {}
};
const DEFAULT_CONFIG = {
  backend: "discord",
  discord: { token: "" },
  telegram: { token: "" },
  access: DEFAULT_ACCESS,
  channel: { channelId: "" }
};
// Shared defaults layer. Merge semantics: user values win; defaults
// only fill missing fields. Helper is exported so the setup UI and
// runtime both produce the same shape when the file has missing sections.
const CONFIG_DEFAULTS = {
  webhook: { enabled: true }
};
function applyDefaults(config) {
  const out = { ...(config || {}) };
  out.webhook = { ...CONFIG_DEFAULTS.webhook, ...(out.webhook || {}) };
  return out;
}

function channelIdForBackend(entry = {}, backend = "discord") {
  if (backend === "telegram") {
    return String(entry?.telegramChatId || (entry?.discordChannelId ? "" : entry?.channelId) || "");
  }
  return String(entry?.discordChannelId || (entry?.telegramChatId ? "" : entry?.channelId) || "");
}

// Resolve the single active-backend channel id from the config's `channel`
// section. Backward compat (read-side only, no on-disk migration): when
// `channel` is absent, fall back to the legacy `channelsConfig[mainChannel]`
// entry (or the first entry that carries an id).
function resolveChannelId(raw = {}, backend = "discord") {
  const channel = raw.channel && typeof raw.channel === "object" ? raw.channel : null;
  if (channel) return channelIdForBackend(channel, backend);
  const legacy = raw.channelsConfig && typeof raw.channelsConfig === "object" ? raw.channelsConfig : null;
  if (legacy) {
    const mainName = raw.mainChannel ?? "main";
    const preferred = legacy[mainName];
    if (preferred && typeof preferred === "object") {
      const id = channelIdForBackend(preferred, backend);
      if (id) return id;
    }
    for (const entry of Object.values(legacy)) {
      if (entry && typeof entry === "object") {
        const id = channelIdForBackend(entry, backend);
        if (id) return id;
      }
    }
  }
  return "";
}

async function loadConfig() {
  try {
    let raw = readSection("channels");
    raw = raw && typeof raw === "object" ? raw : {};
    // Schedules are the PG `scheduler.schedules` table (single source of
    // truth). The legacy SCHEDULE.md store and the `raw.schedules.items` /
    // `raw.nonInteractive` / `raw.interactive` arrays in mixdog-config.json
    // are no longer read. Done one-shots are dropped so they never re-arm.
    const scheduleEntries = (await listSchedules())
      .filter((s) => s.enabled !== false && s.status !== "done");
    // `target` drives routing: 'channel' → non-interactive dispatch to the
    // schedule's channel_id; 'session' → inject into the current (Lead)
    // session. Mirrors the webhook model.
    raw.nonInteractive = scheduleEntries.filter((s) => s.target === "channel");
    raw.interactive = scheduleEntries.filter((s) => s.target === "session");
    const accessChannels = { ...raw.access?.channels ?? {} };
    // voice config lives at the top level of mixdog-config.json (peer of
    // channels), so readSection("channels") never sees it. Pull it explicitly.
    let voice = {};
    try {
      const v = readSection("voice");
      if (v && typeof v === "object") voice = v;
    } catch { /* missing section is fine */ }
    const discordToken = getDiscordToken();
    const discordTokenProblem = diagnoseDiscordTokenValue(discordToken, raw);
    if (discordTokenProblem) {
      process.stderr.write(`mixdog: discord token ignored: ${discordTokenProblem}\n`);
    }
    // Single-backend select: config.backend picks ONE of discord|telegram.
    // Anything else falls back to the discord default.
    const backend = raw.backend === "telegram" ? "telegram" : "discord";
    const telegramToken = getTelegramToken();
    const channelId = resolveChannelId(raw, backend);
    // Drop legacy multi-channel keys from the returned shape; the runtime
    // reads only the resolved `channelId` now (read-side compat lives in
    // resolveChannelId — no on-disk migration).
    const { channelsConfig: _legacyChannels, mainChannel: _legacyMain, ...rawRest } = raw;
    return applyDefaults({
      ...DEFAULT_CONFIG,
      ...rawRest,
      backend,
      channelId,
      discord: { ...DEFAULT_CONFIG.discord, ...(({ token: _, ...rest }) => rest)(raw.discord || {}), ...(discordToken && !discordTokenProblem ? { token: discordToken } : {}) },
      // Merge the keychain-resolved telegram token (harmless when backend is
      // discord; the secret never lands in the on-disk config either way).
      telegram: { ...DEFAULT_CONFIG.telegram, ...(({ token: _t, ...rest }) => rest)(raw.telegram || {}), ...(telegramToken ? { token: telegramToken } : {}) },
      access: {
        ...DEFAULT_ACCESS,
        // Drop the retired pairing-era keys at the config layer too (the
        // Discord backend's normalizeAccess() is the runtime belt): legacy
        // dmPolicy "pairing" → "allowlist", and the `pending` code store is
        // gone entirely.
        ...(({ pending: _pending, ...rest }) => rest)(raw.access || {}),
        ...(raw.access?.dmPolicy === "pairing" ? { dmPolicy: "allowlist" } : {}),
        channels: accessChannels,
      },
      voice: { ...(raw.voice || {}), ...voice }
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      mkdirSync(DATA_DIR, { recursive: true });
      updateSection("channels", () => DEFAULT_CONFIG);
      process.stderr.write(
        `mixdog: default channels config created in ${MIXDOG_CONFIG_PATH}
  edit discord.token and channel.channelId to connect.
`
      );
      return applyDefaults(DEFAULT_CONFIG);
    }
    throw err;
  }
}
const HEADLESS_BACKEND = {
  name: "headless",
  MAX_MESSAGE_LENGTH: 2000,
  formatOutgoing(t) {
    return t;
  },
  async connect() {
  },
  async disconnect() {
  },
  async sendMessage() {
    return { sentIds: [] };
  },
  async fetchMessages() {
    return [];
  },
  async react() {
  },
  async removeReaction() {
  },
  async editMessage() {
    return "";
  },
  async deleteMessage() {
  },
  async downloadAttachment() {
    return Buffer.alloc(0);
  },
  on() {
  }
};
function createBackend(config) {
  // Single-backend select: exactly one backend is constructed based on
  // config.backend (discord|telegram). The two are mutually exclusive.
  if (config.backend === "telegram") {
    const telegramToken = getTelegramToken();
    if (!telegramToken) {
      process.stderr.write("mixdog: telegram bot not configured; channel runtime running in headless mode\n");
      return HEADLESS_BACKEND;
    }
    const tgStateDir = config.telegram?.stateDir ?? join(DATA_DIR, "telegram");
    mkdirSync(tgStateDir, { recursive: true });
    return new TelegramBackend({
      ...config.telegram,
      configPath: CONFIG_FILE,
      access: config.access,
      // Single-source channel setup: the main chat is auto-allowed inside
      // TelegramBackend.loadAccess() so a configured channel.channelId
      // is enough for both inbound gating and outbound.
      mainChannelId: config.channelId
    }, tgStateDir);
  }
  const discordToken = getDiscordToken();
  const discordTokenProblem = diagnoseDiscordTokenValue(discordToken, config);
  if (discordTokenProblem) {
    process.stderr.write(`mixdog: discord token ignored: ${discordTokenProblem}\n`);
  }
  if (config.backend !== "discord" || !discordToken || discordTokenProblem) {
    process.stderr.write("mixdog: discord bot not configured; channel runtime running in headless mode\n");
    return HEADLESS_BACKEND;
  }
  const stateDir = config.discord.stateDir ?? join(DATA_DIR, "discord");
  mkdirSync(stateDir, { recursive: true });
  return new DiscordBackend({
    ...config.discord,
    configPath: CONFIG_FILE,
    access: config.access,
    // Single-source channel setup: the main channel is auto-allowed inside
    // DiscordBackend.loadAccess() so a configured channel.channelId
    // is enough for both inbound and outbound — no separate access.channels entry.
    mainChannelId: config.channelId
  }, stateDir);
}
const PROFILE_FILE = join(DATA_DIR, "profile.json");
function loadProfileConfig() {
  try {
    return JSON.parse(readFileSync(PROFILE_FILE, "utf8"));
  } catch {
    return {};
  }
}
export {
  DATA_DIR,
  createBackend,
  getDiscordToken,
  getTelegramToken,
  loadConfig,
  loadProfileConfig
};
