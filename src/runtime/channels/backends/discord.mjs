
// discord.js is loaded lazily so that importing this module does not pay
// the discord.js initialization cost at top level.
let _discord = null;
let _ChannelType = null;
async function ensureDiscord() {
  if (_discord) return _discord;
  _discord = await import("discord.js");
  _ChannelType = _discord.ChannelType;
  return _discord;
}
import {
  mkdirSync,
  statSync,
  realpathSync
} from "fs";
import { join, sep } from "path";
import { createHash } from "crypto";
import { chunk, formatForDiscord, MAX_DISCORD_MESSAGE } from "../lib/format.mjs";
import { withConfigLock } from "../lib/config-lock.mjs";
import { readSection, updateSectionAsync } from "../../shared/config.mjs";
import { normalizeAccess, safeAttName } from "./discord-access.mjs";
import { MAX_ATTACHMENT_BYTES, downloadSingleAttachment } from "./discord-attachments.mjs";
import * as gateway from "./discord-gateway.mjs";
const MAX_CHUNK_LIMIT = MAX_DISCORD_MESSAGE;
// Per-attempt cap for a single discord.js fetch/send. Without it a wedged
// socket (network blip, "other side closed") leaves the await pending forever,
// which upstream leaves the forwarder's `sending` flag stuck and silences all
// outbound. On timeout we treat the client as dead and reset+reconnect it.
const SEND_ATTEMPT_TIMEOUT_MS = 30_000;
// Reconnect backoff: consecutive _resetClient failures back off exponentially
// with jitter up to a cap so a wedged/rate-limited gateway is not hammered with
// fixed sub-minute destroy()/login() cycles (that fixed cadence triggered
// Discord identify rate-limiting → the ready-timeout death loop).
const RESET_BACKOFF_BASE_MS = 2_000;
const RESET_BACKOFF_CAP_MS = 60_000;
// After a timed-out send is reset, cap how long we wait for the original
// (abandoned) promise to actually settle before giving up with unknown outcome.
const SETTLE_CAP_MS = 15_000;
const RECENT_SENT_CAP = 200;
class DiscordBackend {
  name = "discord";
  MAX_MESSAGE_LENGTH = MAX_DISCORD_MESSAGE;
  onMessage = null;
  onInteraction = null;
  onModalRequest = null;
  onCustomCommand = null;
  client;
  stateDir;
  configFile;
  inboxDir;
  token;
  isStatic;
  bootAccess = null;
  initialAccess;
  recentSentIds = /* @__PURE__ */ new Set();
  sendCount = 0;
  _resetFailures = 0;
  _loginFailures = 0;
  typingIntervals = /* @__PURE__ */ new Map();
  // In-flight sendMessage() promises, awaited by drainPendingSends() before a
  // handoff disconnect so a reply is not cut off mid-delivery.
  _pendingSends = /* @__PURE__ */ new Set();
  constructor(config, stateDir) {
    this.token = config.token;
    this.mainChannelId = config.mainChannelId ?? "";
    this.stateDir = stateDir;
    this.configFile = config.configPath ?? "";
    this.inboxDir = join(stateDir, "inbox");
    this.isStatic = config.accessMode === "static";
    this.initialAccess = normalizeAccess(config.access);
    this.client = null;
  }
  formatOutgoing(text) {
    return formatForDiscord(text);
  }
  // ── discord.js access bridges for extracted gateway module ─────────
  _ensureDiscord() {
    return ensureDiscord();
  }
  _discordEvents() {
    return _discord.Events;
  }
  // ── Lifecycle ──────────────────────────────────────────────────────
  async connect() {
    return gateway.connect(this);
  }
  async disconnect() {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.client) this.client.destroy();
    this._connectPromise = null;
  }
  // ── Self-heal helpers ──────────────────────────────────────────────
  /** Race a discord.js op-promise against a per-attempt timeout so a wedged
   *  socket can't hang the outbound path. On timeout the rejection carries
   *  `_timeout` so the caller knows the underlying op is still in flight (and
   *  must be settled/adopted, not blindly retried → duplicate). */
  _withTimeout(promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${label} timed out after ${SEND_ATTEMPT_TIMEOUT_MS}ms`);
        e._timeout = true;
        reject(e);
      }, SEND_ATTEMPT_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  /** True when an error means the client is dead (aborted, "other side
   *  closed", or our per-attempt timeout) and must be reset+reconnected. */
  _shouldResetClient(err) {
    if (err?.name === "AbortError" || err?.code === "ABORT_ERR") return true;
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("aborted") || msg.includes("other side closed") ||
      msg.includes("socket hang up") || msg.includes("econnreset") || msg.includes("timed out");
  }
  /** Destroy the wedged client and rebuild it via connect() so the next
   *  fetch/send (and the forwarder's queue-head-preserving retry) hits a fresh
   *  gateway/REST client. Serialized behind a single in-flight reset so
   *  concurrent callers await the SAME reconnect instead of racing multiple
   *  destroy()/login() cycles. */
  async _resetClient() {
    if (this._resetPromise) return this._resetPromise;
    this._resetPromise = (async () => {
      // Back off before rebuilding: on repeated reset failures wait an
      // exponentially growing (jittered) delay capped at RESET_BACKOFF_CAP_MS
      // so we never re-identify in a tight loop.
      const n = this._resetFailures || 0;
      if (n > 0) {
        const cap = Math.min(RESET_BACKOFF_CAP_MS, RESET_BACKOFF_BASE_MS * 2 ** (n - 1));
        const delay = Math.floor(cap / 2 + Math.random() * (cap / 2));
        await new Promise((r) => setTimeout(r, delay));
      }
      try { this.client?.destroy?.(); } catch {}
      this.client = null;
      this._connectPromise = null;
      await this.connect();
      this._resetFailures = 0;
    })().catch((err) => {
      this._resetFailures = (this._resetFailures || 0) + 1;
      throw err;
    }).finally(() => { this._resetPromise = null; });
    return this._resetPromise;
  }
  /** Health-check the gateway; reset+reconnect if the ws is not READY. Called
   *  by the owner re-claim self-heal path. (discord.js Status.Ready === 0) */
  async healthCheck() {
    if (this.client && this.client.ws?.status === 0) return;
    await this._resetClient();
  }
  resetSendCount() {
    this.sendCount = 0;
  }
  startTyping(channelId) {
    this.stopTyping(channelId);
    if (!this.client) return;
    const ch = this.client.channels.cache.get(channelId);
    if (ch && "sendTyping" in ch) {
      void ch.sendTyping().catch(() => {
      });
      const interval = setInterval(() => {
        if ("sendTyping" in ch) {
          ch.sendTyping().catch(() => {
          });
        }
      }, 9e3);
      this.typingIntervals.set(channelId, interval);
    }
  }
  stopTyping(channelId) {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }
  // ── Outbound operations ────────────────────────────────────────────
  // Public entry: tracks the send so drainPendingSends() can await in-flight
  // deliveries before an ownership-handoff disconnect. Delegates to the impl.
  async sendMessage(chatId, text, opts) {
    const p = this._sendMessageImpl(chatId, text, opts);
    const tracked = Promise.resolve(p).catch(() => {});
    this._pendingSends.add(tracked);
    tracked.finally(() => this._pendingSends.delete(tracked));
    return p;
  }
  /** Await in-flight sends (bounded) so a handoff drains outbound before
   *  disconnect. Bounded by timeoutMs so a wedged send can't stall teardown. */
  async drainPendingSends(timeoutMs = 4000) {
    if (this._pendingSends.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this._pendingSends]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
  async _sendMessageImpl(chatId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    if (!("send" in ch)) throw new Error("channel is not sendable");
    const files = opts?.files ?? [];
    const replyTo = opts?.replyTo;
    for (const f of files) {
      this.assertSendable(f);
      const st = statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`);
      }
    }
    if (files.length > 10) throw new Error("max 10 attachments per message");
    // Resume-token support (opaque to callers). A partial-send failure hands the
    // caller a token { hash, nextChunkIdx, sentIds, prefixed }; a requeued retry
    // passes it back so we resume at the failed chunk instead of re-sending
    // chunks that already landed.
    //
    // The "\u3164\n" prefix is applied from this.sendCount, which advances when
    // ANY backend send fully succeeds. Between the original partial failure and
    // this retry, an unrelated send (scheduler/lifecycle/permission) can flip
    // sendCount from 0 to >0, which would change the prefix — and therefore the
    // chunked text and its hash — breaking the token match and forcing a
    // duplicate full-resend. To keep the retry byte-identical to the original
    // attempt, freeze the prefix decision in the token and reuse it here instead
    // of recomputing from the (possibly changed) current sendCount.
    const resumeToken = opts?.resumeToken;
    const applyPrefix = (resumeToken && typeof resumeToken.prefixed === "boolean")
      ? resumeToken.prefixed
      : (text && this.sendCount > 0 ? true : false);
    if (text && applyPrefix) {
      text = "\u3164\n" + text;
    }
    const access = this.loadAccess();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const replyMode = access.replyToMode ?? "off";
    const chunks = chunk(text, limit);
    // Hash the FINAL prefixed text so the token pins to the exact bytes sent.
    const contentHash = createHash("md5").update(text).digest("hex");
    let startIdx = 0;
    const sentIds = [];
    // Resume only when BOTH the text hash AND the effective chunk limit match.
    // The token's nextChunkIdx is an index into the chunk array, which is only
    // meaningful for the same `limit`; if access.textChunkLimit changed during
    // the retry window the same text can split differently, so a stale index
    // could skip or duplicate a range. On mismatch fall through to startIdx=0
    // (full, safe resend).
    if (resumeToken && resumeToken.hash === contentHash && resumeToken.limit === limit) {
      startIdx = Math.max(0, Math.min(resumeToken.nextChunkIdx ?? 0, chunks.length));
      // Seed sentIds with the already-delivered ids so the returned list stays
      // complete across the resume boundary.
      if (Array.isArray(resumeToken.sentIds)) sentIds.push(...resumeToken.sentIds);
    }
    try {
      for (let i = startIdx; i < chunks.length; i++) {
        const shouldReplyTo = replyTo != null && replyMode !== "off" && (replyMode === "all" || i === 0);
        const embeds = i === 0 ? opts?.embeds ?? [] : [];
        const components = i === 0 ? opts?.components ?? [] : [];
        const payload = {
          content: chunks[i],
          ...embeds.length > 0 ? { embeds } : {},
          ...components.length > 0 ? { components } : {},
          ...i === 0 && files.length > 0 ? { files } : {},
          ...shouldReplyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}
        };
        // Per-chunk send with retry. On 429 honour Retry-After; on other
        // transient errors do a short backoff. Cap at 3 attempts per chunk;
        // after the cap throw an error carrying a resume token so the caller
        // (output-forwarder) requeues the WHOLE item and the next sendMessage
        // resumes at this chunk index instead of re-sending 0..i-1.
        let attempt = 0;
        for (;;) {
          const sendPromise = ch.send(payload);
          try {
            const sent = await this._withTimeout(sendPromise, "discord send");
            this.noteSent(sent.id);
            sentIds.push(sent.id);
            break;
          } catch (err) {
            attempt++;
            if (err?._timeout) {
              // Watchdog abandoned the send but the socket may still deliver.
              // Destroy the client to tear down the in-flight REST socket so the
              // ORIGINAL promise settles, then AWAIT + adopt its real outcome:
              // delivered → done (no retry → no duplicate); else requeue against
              // the fresh client via a resume token.
              try { await this._resetClient(); } catch {}
              // Cap the settlement wait: destroy() should abort the in-flight
              // socket, but never hang here if it doesn't. On unknown outcome
              // throw retryable (duplicate risk accepted over a permanent hang).
              sendPromise.catch(() => {}); // swallow a late rejection
              const settled = await Promise.race([
                sendPromise.then((v) => ({ ok: true, v }), () => ({ ok: false })),
                new Promise((r) => setTimeout(() => r({ ok: false }), SETTLE_CAP_MS))
              ]);
              if (settled.ok) {
                this.noteSent(settled.v.id);
                sentIds.push(settled.v.id);
                break;
              }
              const e = err instanceof Error ? err : new Error(String(err));
              e.resumeToken = { hash: contentHash, nextChunkIdx: i, sentIds: [...sentIds], prefixed: applyPrefix, limit };
              throw e;
            }
            const status = err?.status ?? err?.code ?? err?.httpStatus;
            // Classify: PERMANENT = a 4xx client error (unknown channel/message,
            // missing access/permissions, 404 …) that will never succeed on
            // retry. TRANSIENT = 429, any 5xx, or network error (no status). A
            // permanent error must NOT retry-loop and must NOT carry a resume
            // token — throw it immediately flagged so the forwarder drops the
            // item instead of requeuing forever.
            const isPermanent = typeof status === "number" && status >= 400 && status < 500 && status !== 429;
            if (isPermanent) {
              const e = err instanceof Error ? err : new Error(String(err));
              e.permanent = true;
              throw e;
            }
            // Dead client (abort / "other side closed" / per-attempt timeout):
            // destroy + reconnect so the forwarder's transient-retry path hits a
            // fresh client, and throw a resume token now instead of burning the
            // remaining attempts on a stale channel handle bound to the old client.
            const dead = this._shouldResetClient(err);
            if (dead) {
              try { await this._resetClient(); } catch {}
            }
            if (dead || attempt >= 3) {
              // Attach an opaque resume token pointing at the chunk that failed
              // (i). sentIds holds every chunk already delivered (including any
              // seeded from a prior token).
              const e = err instanceof Error ? err : new Error(String(err));
              e.resumeToken = { hash: contentHash, nextChunkIdx: i, sentIds: [...sentIds], prefixed: applyPrefix, limit };
              throw e;
            }
            if (status === 429) {
              // @discordjs/rest RateLimitError.retryAfter is ALWAYS in ms
              // (no unit guess). Clamp to [0, 60000]; fall back to 1s when the
              // field is absent/invalid. (discord.js also auto-sleeps rate
              // limits internally, so we rarely even reach this branch.)
              const retryAfterMs = Number(err?.retryAfter);
              const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, 60_000) : 1000;
              await new Promise((r) => setTimeout(r, ms));
            } else {
              // Other transient error (5xx / network): short backoff.
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        }
      }
      this.sendCount += sentIds.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`send failed after ${sentIds.length}/${chunks.length} chunk(s): ${msg}`);
      // Preserve the opaque resume token across the rewrap so the caller can
      // persist it on the queue item and resume on retry.
      if (err?.resumeToken) wrapped.resumeToken = err.resumeToken;
      // Propagate the permanent flag so the forwarder drops (not requeues) it.
      if (err?.permanent) wrapped.permanent = true;
      throw wrapped;
    }
    return { sentIds };
  }
  async fetchMessages(channelId, limit) {
    const ch = await this.fetchAllowedChannel(channelId);
    const capped = Math.min(limit, 100);
    const msgs = await ch.messages.fetch({ limit: capped });
    const me = this.client.user?.id;
    return [...msgs.values()].reverse().map((m) => ({
      id: m.id,
      user: m.author.id === me ? "me" : m.author.username,
      text: m.content.replace(/[\r\n]+/g, " \u23CE "),
      ts: m.createdAt.toISOString(),
      isMe: m.author.id === me,
      attachmentCount: m.attachments.size
    }));
  }
  async react(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.react(emoji);
  }
  async removeReaction(chatId, messageId, emoji) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const me = this.client.user?.id;
    if (me) {
      const reaction = msg.reactions.cache.get(emoji);
      if (reaction) await reaction.users.remove(me);
    }
  }
  async editMessage(chatId, messageId, text, opts) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    const access = this.loadAccess();
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const chunks = chunk(text, limit);
    const edited = await msg.edit({
      content: chunks[0] || null,
      ...opts?.embeds ? { embeds: opts.embeds } : {},
      ...opts?.components ? { components: opts.components } : {}
    });
    const sentIds = [edited.id];
    // Idempotent overflow: reuse previously-sent overflow messages, replacing
    // rather than appending on every edit call.
    if (!this.editOverflow) this.editOverflow = Object.create(null);
    const prevOverflow = this.editOverflow[messageId] ?? [];
    const newOverflow = [];
    for (let i = 1; i < chunks.length; i++) {
      const prevId = prevOverflow[i - 1];
      if (prevId) {
        try {
          const prevMsg = await ch.messages.fetch(prevId);
          await prevMsg.edit({ content: chunks[i] });
          newOverflow.push(prevId);
          sentIds.push(prevId);
          continue;
        } catch { /* message deleted externally — fall through to send */ }
      }
      const sent = await ch.send({ content: chunks[i] });
      this.noteSent(sent.id);
      newOverflow.push(sent.id);
      sentIds.push(sent.id);
    }
    // Delete leftover overflow messages from a prior longer edit.
    for (let j = chunks.length - 1; j < prevOverflow.length; j++) {
      try { const m = await ch.messages.fetch(prevOverflow[j]); await m.delete(); } catch { /* already gone */ }
    }
    this.editOverflow[messageId] = newOverflow;
    return sentIds[0];
  }
  async deleteMessage(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    await msg.delete();
  }
  async downloadAttachment(chatId, messageId, opts = {}) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    if (msg.attachments.size === 0) return [];
    const results = [];
    // Optional filter bounds what gets fetched (e.g. image/* only) so a
    // caller after images never pulls unrelated large attachments.
    const filter = typeof opts.filter === "function" ? opts.filter : null;
    for (const att of msg.attachments.values()) {
      const meta = {
        id: att.id,
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      };
      if (filter && !filter(meta)) continue;
      const path = await this.downloadSingleAttachment(att, opts);
      results.push({
        ...meta,
        path
      });
    }
    return results;
  }
  async validateChannel(chatId) {
    await this.fetchAllowedChannel(chatId);
  }
  // ── Access control ─────────────────────────────────────────────────
  readConfigAccess() {
    try {
      const parsed = readSection("channels");
      const access = normalizeAccess(parsed.access ?? this.initialAccess);
      // Single main channel: auto-allow the configured channel id so channel
      // adds apply without a restart (mirrors loadAccess()).
      const id = this.mainChannelId;
      if (id && !(id in access.channels)) {
        access.channels[id] = { requireMention: false, allowFrom: [] };
      }
      return access;
    } catch {
      return this.initialAccess;
    }
  }
  async persistAccessFromMainChannel() {
    if (this.isStatic || !this.configFile) return;
    try {
      const id = this.mainChannelId;
      if (!id) return;
      const parsed = readSection("channels");
      const access = normalizeAccess(parsed.access);
      if (!(id in access.channels)) {
        access.channels[id] = { requireMention: false, allowFrom: [] };
        await this.saveAccess(access);
      }
    } catch (err) {
      process.stderr.write(`mixdog discord: persistAccessFromMainChannel failed: ${err}\n`);
    }
  }
  loadAccess() {
    const a = this.bootAccess ?? this.readConfigAccess();
    // Single-source channel setup: auto-allow the configured main channel so
    // both inbound (gate) and outbound (fetchAllowedChannel) accept it from a
    // single channel.channelId — no separate access.channels entry.
    // An explicit entry for the same channel is preserved (not overwritten).
    if (this.mainChannelId && a && !(this.mainChannelId in (a.channels ?? {}))) {
      return { ...a, channels: { ...(a.channels ?? {}), [this.mainChannelId]: { allowFrom: [], requireMention: false } } };
    }
    return a;
  }
  async saveAccess(a) {
    if (this.isStatic) return;
    if (!this.configFile) return;
    return withConfigLock(async () => {
      mkdirSync(this.stateDir, { recursive: true, mode: 448 });
      const access = {
        dmPolicy: a.dmPolicy,
        allowFrom: a.allowFrom,
        channels: a.channels,
        ...a.mentionPatterns ? { mentionPatterns: a.mentionPatterns } : {},
        ...a.ackReaction ? { ackReaction: a.ackReaction } : {},
        ...a.replyToMode ? { replyToMode: a.replyToMode } : {},
        ...a.textChunkLimit ? { textChunkLimit: a.textChunkLimit } : {}
      };
      await updateSectionAsync("channels", (channels) => ({
        ...channels,
        access
      }));
    });
  }
  // Trust decision for component/modal interactions, which otherwise bypass
  // gate() entirely. Mirrors gate()'s channel branch: a channel (or, when no
  // channel policy applies, the global) allowFrom list is enforced when set,
  // while an empty allowFrom stays open so existing configs are unchanged.
  // requireMention is N/A for a click; dmPolicy "disabled" drops all.
  _interactionAllowed(channelId, userId, interaction) {
    if (!userId) return false;
    const access = this.loadAccess();
    if (!access || access.dmPolicy === "disabled") return false;
    // Mirror gate(): normalize threads to their parent channel so component
    // clicks in threads inherit the parent's access policy instead of falling
    // back to the global allowFrom.
    let resolvedChannelId = channelId;
    let isDM = false;
    try {
      const ch = interaction?.channel;
      if (ch?.isThread?.()) resolvedChannelId = ch.parentId ?? channelId;
      // Detect DM interactions. gate() honors the DM allowlist; a blanket
      // non-DM fail-closed would deny e.g. global /stop.
      if (ch?.type === _ChannelType.DM || ch?.isDMBased?.()) isDM = true;
    } catch {}
    if (isDM) {
      // Mirror gate()'s DM path exactly: deliver iff the sender is in the
      // global allowFrom. dmPolicy "disabled" was already filtered above.
      if (access.allowFrom?.includes?.(userId)) return true;
      return false;
    }
    const policy = resolvedChannelId ? access.channels?.[resolvedChannelId] : null;
    // Mirror gate(): when this looks like a configured guild channel and no
    // per-channel policy exists, fail closed (drop) instead of falling back
    // to the global allowFrom. Component/modal interactions outside any
    // configured channel policy should be treated the same as messages there.
    if (!policy && resolvedChannelId) return false;
    const allowFrom = (policy ? policy.allowFrom : access.allowFrom) ?? [];
    if (allowFrom.length > 0 && !allowFrom.includes(userId)) return false;
    return true;
  }
  async gate(msg) {
    const access = this.loadAccess();
    if (access.dmPolicy === "disabled") return { action: "drop" };
    const senderId = msg.author.id;
    const isDM = msg.channel.type === _ChannelType.DM;
    if (isDM) {
      if (access.allowFrom.includes(senderId)) return { action: "deliver", access };
      return { action: "drop" };
    }
    const channelId = msg.channel.isThread() ? msg.channel.parentId ?? msg.channelId : msg.channelId;
    const policy = access.channels[channelId];
    if (!policy) return { action: "drop" };
    const channelAllowFrom = policy.allowFrom ?? [];
    const requireMention = policy.requireMention ?? false;
    if (channelAllowFrom.length > 0 && !channelAllowFrom.includes(senderId)) {
      return { action: "drop" };
    }
    if (requireMention && !await this.isMentioned(msg, access.mentionPatterns)) {
      return { action: "drop" };
    }
    return { action: "deliver", access };
  }
  async isMentioned(msg, extraPatterns) {
    if (this.client.user && msg.mentions.has(this.client.user)) return true;
    const refId = msg.reference?.messageId;
    if (refId) {
      if (this.recentSentIds.has(refId)) return true;
      try {
        const ref = await msg.fetchReference();
        if (ref.author.id === this.client.user?.id) return true;
      } catch {
      }
    }
    const text = msg.content;
    for (const pat of extraPatterns ?? []) {
      if (typeof pat !== "string" || pat.length === 0 || pat.length > 128) continue;
      // Reject known catastrophic-backtracking shapes: nested quantifiers
      // like (x+)+, (x*)*, (x+)*, (x*)+ on grouped subexpressions.
      if (/\([^)]*[+*]\)[+*]/.test(pat)) continue;
      try {
        if (new RegExp(pat, "i").test(text)) return true;
      } catch {
        throw new Error(`[discord] invalid mention pattern: ${pat}`);
      }
    }
    return false;
  }
  // ── Inbound handling ───────────────────────────────────────────────
  async handleInbound(msg, receivedAtMs = Date.now()) {
    const result = await this.gate(msg);
    if (result.action === "drop") return;
    if (result.access.ackReaction) {
      void msg.react(result.access.ackReaction).catch(() => {
      });
    }
    const atts = [];
    for (const att of msg.attachments.values()) {
      atts.push({
        id: att.id,
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
      });
    }
    const text = msg.content || (atts.length > 0 ? "(attachment)" : "");
    if (text.match(/^\/(bot|profile)\s*\(/) && this.onCustomCommand) {
      const replyFn = async (reply, opts) => {
        try {
          const ch = await this.fetchAllowedChannel(msg.channelId);
          if ("send" in ch) {
            await ch.send({
              ...reply ? { content: reply } : {},
              ...opts?.embeds?.length ? { embeds: opts.embeds } : {},
              ...opts?.components?.length ? { components: opts.components } : {}
            });
          }
        } catch (err) {
          process.stderr.write(`mixdog discord: custom command reply failed: ${err}
`);
        }
      };
      this.onCustomCommand(text, msg.channelId, msg.author.id, replyFn);
      return;
    }
    if (this.onMessage) {
      // Thread messages were gated against the parent channel's policy (see
      // gate() above). Surface parentChatId so downstream routing can fall
      // back to the parent when the thread id needs it.
      const isThread = (() => { try { return !!msg.channel?.isThread?.(); } catch { return false; } })();
      const parentChatId = isThread ? (msg.channel.parentId ?? null) : null;
      this.onMessage({
        chatId: msg.channelId,
        parentChatId,
        messageId: msg.id,
        receivedAtMs,
        discordCreatedAtMs: msg.createdTimestamp ?? msg.createdAt?.getTime?.() ?? null,
        user: msg.author.username,
        userId: msg.author.id,
        text,
        ts: msg.createdAt.toISOString(),
        attachments: atts
      });
    }
  }
  // ── Channel helpers ────────────────────────────────────────────────
  async fetchTextChannel(id) {
    if (!this.client) await this.connect();
    const p = this.client.channels.fetch(id);
    p.catch(() => {}); // if the watchdog wins, don't leak an unhandled rejection
    const ch = await this._withTimeout(p, "discord channels.fetch");
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`);
    }
    return ch;
  }
  async fetchAllowedChannel(id) {
    const ch = await this.fetchTextChannel(id);
    const access = this.loadAccess();
    if (ch.type === _ChannelType.DM) {
      let recipientId = ch.recipientId;
      if (!recipientId && ch.partial) {
        const fetched = await ch.fetch();
        recipientId = fetched.recipientId;
      }
      if (recipientId && access.allowFrom.includes(recipientId)) return ch;
    } else {
      const key = ch.isThread() ? ch.parentId ?? ch.id : ch.id;
      if (key in access.channels) return ch;
    }
    throw new Error(`channel ${id} is not allowlisted: add it via the Setup UI channels panel`);
  }
  noteSent(id) {
    this.recentSentIds.add(id);
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const first = this.recentSentIds.values().next().value;
      if (first) this.recentSentIds.delete(first);
    }
  }
  assertSendable(f) {
    let real, stateReal;
    try {
      real = realpathSync(f);
      stateReal = realpathSync(this.stateDir);
    } catch (err) {
      // Fail closed: state dir is created at boot so realpath should succeed
      // invariantly; a missing `f` would fail downstream anyway. Skipping the
      // state-guard on realpath failure was a bypass for symlinked attachments.
      throw new Error(`refusing to send: cannot resolve real path for ${f} (${err?.message || err})`);
    }
    const inbox = join(stateReal, "inbox");
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`);
    }
  }
  async downloadSingleAttachment(att, opts = {}) {
    return downloadSingleAttachment(att, this.inboxDir, opts);
  }
}
export {
  DiscordBackend
};
