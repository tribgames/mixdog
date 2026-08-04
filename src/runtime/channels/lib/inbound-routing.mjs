import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureDir, removeFileIfExists } from "./state-file.mjs";

// Inbound message routing / dedup / ownership helpers. Extracted verbatim
// from channels/index.mjs (behavior-preserving). Bound to live getters
// (getConfig, getInstanceId) so runtime config/identity reloads keep the
// original file-level reference semantics.
function createInboundRouting({ getConfig, getInstanceId, getChannelOwnerPath }) {
  const INBOUND_DEDUP_TTL = 5 * 6e4;
  const inboundSeen = /* @__PURE__ */ new Map();
  const INBOUND_DEDUP_DIR = path.join(os.tmpdir(), "mixdog-inbound");
  ensureDir(INBOUND_DEDUP_DIR);

  function writeChannelOwner(channelId) {
    const ownerPath = getChannelOwnerPath(channelId);
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ instanceId: getInstanceId(), pid: process.pid, updatedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  function shouldDropDuplicateInbound(msg) {
    const key = `${msg.chatId}:${msg.messageId}`;
    const now = Date.now();
    if (inboundSeen.has(key) && now - inboundSeen.get(key) < INBOUND_DEDUP_TTL) return true;
    inboundSeen.set(key, now);
    // Cross-process marker write MUST stay synchronous: a fire-and-forget wx
    // write opens a duplicate-delivery window where two processes both return
    // false before either callback observes EEXIST. Single small write+stat is
    // cheap. Only the periodic sweep is moved off the hot path (async).
    const marker = path.join(INBOUND_DEDUP_DIR, key.replace(/:/g, "_"));
    try {
      fs.writeFileSync(marker, String(now), { flag: "wx" });
    } catch (e) {
      if (e.code === "EEXIST") {
        try {
          const stat = fs.statSync(marker);
          if (now - stat.mtimeMs < INBOUND_DEDUP_TTL) return true;
        } catch {}
      }
    }
    scheduleSweep(now);
    for (const [k, t] of inboundSeen) {
      if (now - t > INBOUND_DEDUP_TTL) inboundSeen.delete(k);
    }
    return false;
  }

  function scheduleSweep(now) {
    if (Math.random() < 0.1) {
      fs.readdir(INBOUND_DEDUP_DIR, (e, list) => {
        if (e) return;
        for (const f of list) {
          const fp = path.join(INBOUND_DEDUP_DIR, f);
          fs.stat(fp, (se, stat) => {
            if (!se && now - stat.mtimeMs > INBOUND_DEDUP_TTL) removeFileIfExists(fp);
          });
        }
      });
    }
  }

  function resolveInboundRoute(chatId, parentChatId) {
    const config = getConfig();
    // Single main channel: there is no per-channel label/mode map anymore.
    // Every inbound message routes as interactive to its own chat id.
    return { targetChatId: chatId, sourceChatId: chatId, sourceLabel: undefined, sourceMode: "interactive" };
  }

  return {
    writeChannelOwner,
    shouldDropDuplicateInbound,
    resolveInboundRoute,
  };
}

export { createInboundRouting };
