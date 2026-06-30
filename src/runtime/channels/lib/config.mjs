import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DiscordBackend } from "../backends/discord.mjs";
import { readSection, updateSection, CONFIG_PATH as MIXDOG_CONFIG_PATH, getDiscordToken, diagnoseDiscordTokenValue } from "../../shared/config.mjs";
import { listSchedules } from "../../shared/schedules-store.mjs";
import { resolvePluginData } from "../../shared/plugin-paths.mjs";
import { isHolidaySync } from "./holidays.mjs";
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
  access: DEFAULT_ACCESS,
  mainChannel: "main",
  channelsConfig: {
    main: { channelId: "", mode: "interactive" }
  }
};
// Shared defaults layer (DND / per-channel respectQuiet). Merge
// semantics: user values win; defaults only fill missing fields.
// Helper is exported so the setup UI and runtime both produce the same
// shape when the file has missing sections.
const CONFIG_DEFAULTS = {
  quiet: { schedule: "23:00-09:00", holidays: false },
  schedules: { respectQuiet: true },
  webhook: { enabled: true, respectQuiet: false }
};
const DEFAULT_HOLIDAY_COUNTRY = "KR";
function normalizeHolidaySetting(value) {
  if (value === true) return DEFAULT_HOLIDAY_COUNTRY;
  if (typeof value === "string") {
    const code = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : false;
  }
  return false;
}
function applyDefaults(config) {
  const out = { ...(config || {}) };
  out.quiet = { ...CONFIG_DEFAULTS.quiet, ...(out.quiet || {}) };
  out.quiet.holidays = normalizeHolidaySetting(out.quiet.holidays);
  out.schedules = { ...CONFIG_DEFAULTS.schedules, ...(out.schedules || {}) };
  out.webhook = { ...CONFIG_DEFAULTS.webhook, ...(out.webhook || {}) };
  return out;
}
/**
 * Shared DND / quiet-window helper used by scheduler + webhook.
 *
 * Signature contract (as of 0.1.62):
 *   isInQuietWindow(cfg, now = new Date(), tz = null) -> boolean
 *
 * `cfg` accepts exactly two shapes (top-level config with `.quiet`
 * subtree, or a flat `{ schedule, holidays }` descriptor); anything
 * else returns `false`.
 *
 * `tz` is an optional IANA timezone. When set, both the schedule
 * window (HH:MM) and the holiday/weekend day are evaluated in that
 * zone; when absent, the host's local timezone is used (unchanged
 * behavior for callers that omit it, e.g. webhook.mjs).
 *
 * Behavior:
 *   - Schedule window uses "HH:MM-HH:MM". Midnight-crossing windows
 *     (start > end, e.g. "23:00-09:00") are honored. When start === end
 *     the window is treated as empty/never (preserved doc-ambiguous
 *     behavior — callers should avoid that shape).
 *   - `holidays` enabled AND today is a recognized holiday  => true,
 *     regardless of schedule window.
 *   - `holidays === false` or missing => holidays ignored.
 *
 * Holiday detection strategy (0.1.63):
 *   Sync, non-blocking lookup via holidays.mjs `isHolidaySync`, backed
 *   by a pre-warmed in-memory cache (Nager-sourced). The `holidays`
 *   value doubles as the ISO country code (`true` => default country).
 *   - cache WARM  => real public-holiday data (weekday holidays count).
 *   - cache COLD  => documented fallback: weekend-only (Sat/Sun), while
 *     an async warm is kicked off for the next evaluation. No blocking
 *     I/O and no heuristics beyond this weekend fallback.
 *
 * Exported so scheduler.mjs and webhook.mjs can share one implementation.
 */
// Day-of-week and HH:MM for `now`, in `tz` when given, else host-local.
// An invalid IANA `tz` makes `Intl.DateTimeFormat` throw a RangeError;
// we catch it once and fall back to host-local rather than propagating.
function quietDayTime(now, tz) {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour12: false, timeZone: tz,
        hour: "2-digit", minute: "2-digit", weekday: "short",
      }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      const hour = parts.hour === "24" ? "00" : parts.hour;
      const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return {
        dow: dowMap[parts.weekday] ?? now.getDay(),
        hhmm: `${hour}:${parts.minute}`,
      };
    } catch {
      // Invalid timezone — fall through to host-local.
    }
  }
  return {
    dow: now.getDay(),
    hhmm: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
  };
}
// Return the target calendar day as a plain 'YYYY-MM-DD' string, in `tz`
// when given (else host-local). A string (not a Date) keeps the holiday
// contract symmetric: isHolidaySync compares the same string, so there
// is no UTC<->local round-trip to shift the day on UTC+12..+14 hosts.
// An invalid IANA `tz` throws a RangeError; catch once, fall to local.
function quietHolidayDateStr(now, tz) {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch {
      // Invalid timezone — fall through to host-local.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function isInQuietWindow(cfg, now = new Date(), tz = null) {
  if (!cfg || typeof cfg !== "object") return false;
  // Auto-detect shape: prefer cfg.quiet when present, else treat cfg as
  // the flat { schedule, holidays } descriptor.
  const quiet = cfg.quiet && typeof cfg.quiet === "object" ? cfg.quiet : cfg;
  const schedule = quiet.schedule;
  const holidaysOn = quiet.holidays === true || (typeof quiet.holidays === "string" && !!quiet.holidays.trim());
  const country = quiet.holidays === true
    ? DEFAULT_HOLIDAY_COUNTRY
    : (typeof quiet.holidays === "string" ? quiet.holidays.trim().toUpperCase() : null);

  // Holiday branch: toggle on AND today qualifies => quiet regardless of window.
  // Sync, pre-warmed cache lookup; cold cache falls back to weekend-only.
  if (holidaysOn) {
    const holiday = isHolidaySync(quietHolidayDateStr(now, tz), country);
    if (holiday === true) return true;
    if (holiday === null) {
      // Cold cache: documented Sat/Sun fallback until the async warm lands.
      const { dow } = quietDayTime(now, tz);
      if (dow === 0 || dow === 6) return true;
    }
    // Warm cache + not a holiday: fall through to the schedule window.
  }

  // Schedule window check (TZ-aware when tz is set; host-local otherwise).
  if (!schedule || typeof schedule !== "string") return false;
  const parts = schedule.split("-");
  if (parts.length !== 2) return false;
  const [start, end] = parts;
  // start === end => empty window (never matches); documented caveat.
  const { hhmm } = quietDayTime(now, tz);
  if (start > end) return hhmm >= start || hhmm < end; // midnight-crossing
  return hhmm >= start && hhmm < end;
}
function loadConfig() {
  try {
    let raw = readSection("channels");
    raw = raw && typeof raw === "object" ? raw : {};
    // Schedules live in the Mixdog data dir under `schedules/<name>/` (single
    // source of truth). The legacy `raw.schedules.items` / `raw.nonInteractive`
    // / `raw.interactive` arrays in mixdog-config.json are no longer read.
    const scheduleEntries = listSchedules().filter((s) => s.enabled !== false);
    // Channel-presence routing (no `type` field): an entry WITH a channel is
    // dispatched directly to that channel; an entry WITHOUT a channel is
    // injected into the current (Lead) session. Mirrors the webhook model.
    raw.nonInteractive = scheduleEntries.filter((i) => !!i.channel);
    raw.interactive = scheduleEntries.filter((i) => !i.channel);
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
    return applyDefaults({
      ...DEFAULT_CONFIG,
      ...raw,
      backend: "discord",
      discord: { ...DEFAULT_CONFIG.discord, ...(({ token: _, ...rest }) => rest)(raw.discord || {}), ...(discordToken && !discordTokenProblem ? { token: discordToken } : {}) },
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
  edit discord.token and channelsConfig.main.channelId to connect.
`
      );
      return applyDefaults(DEFAULT_CONFIG);
    }
    throw err;
  }
}
const HEADLESS_BACKEND = {
  name: "headless",
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
    // DiscordBackend.loadAccess() so a configured channelsConfig.main.channelId
    // is enough for both inbound and outbound — no separate access.channels entry.
    mainChannelId: config.channelsConfig?.main?.channelId
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
  DEFAULT_HOLIDAY_COUNTRY,
  createBackend,
  getDiscordToken,
  isInQuietWindow,
  loadConfig,
  loadProfileConfig
};
