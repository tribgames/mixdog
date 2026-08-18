import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  readSection,
  updateSection,
  CONFIG_PATH as MIXDOG_CONFIG_PATH,
} from "../../shared/config.mjs";
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
  access: DEFAULT_ACCESS,
  channel: {}
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
    // Every schedule fires as a visible session run (runScheduleSession)
    // through the non-interactive dispatch path; `target` only decides
    // whether the RESULT is relayed to the schedule's channel. The legacy
    // interactive bucket (Lead-session inject) is retired.
    raw.nonInteractive = scheduleEntries;
    raw.interactive = [];
    const accessChannels = { ...raw.access?.channels ?? {} };
    // voice config lives at the top level of mixdog-config.json (peer of
    // channels), so readSection("channels") never sees it. Pull it explicitly.
    let voice = {};
    try {
      const v = readSection("voice");
      if (v && typeof v === "object") voice = v;
    } catch { /* missing section is fine */ }
    // Messaging is retired: no provider select, no tokens, no channel id.
    return applyDefaults({
      ...DEFAULT_CONFIG,
      ...raw,
      channelId: "",
      access: {
        ...DEFAULT_ACCESS,
        ...(raw.access || {}),
        channels: accessChannels,
      },
      voice: { ...(raw.voice || {}), ...voice }
    });
  } catch (err) {
    if (err.code === "ENOENT") {
      mkdirSync(DATA_DIR, { recursive: true });
      updateSection("channels", () => DEFAULT_CONFIG);
      process.stderr.write(
        `mixdog: default channels config created in ${MIXDOG_CONFIG_PATH}\n`
      );
      return applyDefaults(DEFAULT_CONFIG);
    }
    throw err;
  }
}
const HEADLESS_PROVIDER = {
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
  },
  startTyping() {
  },
  stopTyping() {
  }
};
function createProvider() {
  // Discord/Telegram messaging is retired (user decision: the PWA replaces
  // it). The channel runtime always runs headless: automation
  // (scheduler/webhooks) and voice transcription keep the worker alive while
  // every messaging call is a no-op.
  return HEADLESS_PROVIDER;
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
  createProvider,
  loadConfig,
  loadProfileConfig
};
