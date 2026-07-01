import { mkdirSync } from "fs";
import { createHash } from "crypto";
import { chunk } from "../lib/format.mjs";
import { readSection } from "../../shared/config.mjs";
import { toMarkdownV2, stripMdV2, isParseEntitiesError } from "../lib/telegram-format.mjs";

const MAX_TELEGRAM_MESSAGE = 4096;
const API_BASE = "https://api.telegram.org";

// Chunk raw text so that EACH chunk still fits Telegram's limit AFTER
// MarkdownV2 escaping. We first chunk normally (code-fence aware), then for any
// chunk whose converted (escaped) form exceeds `limit`, we split that raw chunk
// into smaller raw pieces until every piece converts to <= limit. Splitting the
// RAW text (not the converted text) keeps each piece a self-contained
// MarkdownV2 conversion (no entity/escape spans a piece boundary). A hard
// character-count floor prevents infinite recursion on pathological input.
const MDV2_MIN_RAW_SLICE = 256;
function chunkForMarkdownV2(text, limit) {
  const raw = chunk(text, limit);
  const out = [];
  for (const piece of raw) {
    out.push(...splitRawUntilConvertedFits(piece, limit));
  }
  return out.length > 0 ? out : [""];
}
function splitRawUntilConvertedFits(piece, limit) {
  if (!piece) return [piece];
  if (toMarkdownV2(piece).length <= limit || piece.length <= MDV2_MIN_RAW_SLICE) {
    return [piece];
  }
  // Prefer a newline boundary near the midpoint so we don't cut mid-line;
  // fall back to the raw midpoint. Re-chunk each half through chunk() first so
  // code fences stay balanced, then recurse for the escape-size guarantee.
  const mid = Math.floor(piece.length / 2);
  const nl = piece.lastIndexOf("\n", mid);
  const cut = nl > MDV2_MIN_RAW_SLICE ? nl + 1 : mid;
  const left = piece.slice(0, cut);
  const right = piece.slice(cut);
  const result = [];
  for (const half of [left, right]) {
    for (const sub of chunk(half, limit)) {
      result.push(...splitRawUntilConvertedFits(sub, limit));
    }
  }
  return result;
}

function defaultAccess() {
  return {
    dmPolicy: "allowlist",
    allowFrom: [],
    channels: {}
  };
}

function normalizeAccess(parsed) {
  const defaults = defaultAccess();
  return {
    dmPolicy: parsed?.dmPolicy === "pairing" ? "allowlist" : (parsed?.dmPolicy ?? defaults.dmPolicy),
    allowFrom: parsed?.allowFrom ?? defaults.allowFrom,
    channels: parsed?.channels ?? defaults.channels,
    mentionPatterns: parsed?.mentionPatterns,
    ackReaction: parsed?.ackReaction === true
      ? "\uD83D\uDC4D"
      : (typeof parsed?.ackReaction === "string" && parsed.ackReaction ? parsed.ackReaction : undefined),
    replyToMode: parsed?.replyToMode,
    textChunkLimit: parsed?.textChunkLimit,
  };
}

// Telegram Bot API backend. Mirrors DiscordBackend's PUBLIC surface (the members
// index.mjs / output-forwarder rely on) so createBackend() can hand either one to
// the same runtime with no call-site changes. INBOUND via long-poll getUpdates;
// OUTBOUND as plain text (no parse_mode) so code fences survive verbatim.
class TelegramBackend {
  name = "telegram";
  MAX_MESSAGE_LENGTH = MAX_TELEGRAM_MESSAGE;
  onMessage = null;
  // Telegram has no Discord-style slash/component interaction parity. These
  // hooks are kept present-but-inert so index.mjs assignments/reads don't throw.
  onInteraction = null;
  onModalRequest = null;
  onCustomCommand = null;
  token;
  mainChannelId;
  stateDir;
  configFile;
  isStatic;
  initialAccess;
  sendCount = 0;
  // Long-poll state.
  _polling = false;
  _pollAbort = null;
  _connectPromise = null;
  _offset = 0;
  _typingIntervals = /* @__PURE__ */ new Map();
  constructor(config, stateDir) {
    this.token = config.token;
    this.mainChannelId = config.mainChannelId ?? "";
    this.stateDir = stateDir;
    this.configFile = config.configPath ?? "";
    this.isStatic = config.accessMode === "static";
    this.initialAccess = normalizeAccess(config.access);
    try { mkdirSync(this.stateDir, { recursive: true }); } catch {}
  }
  // Passthrough by design. MarkdownV2 conversion happens PER-CHUNK inside
  // sendMessage (after chunking), NOT here — converting the whole text here
  // then chunking on raw length could split through the middle of a MarkdownV2
  // entity and produce an unbalanced-entity 400. Keeping formatOutgoing a
  // no-op also guarantees conversion runs exactly once (at send time) so there
  // is no risk of double-escaping.
  formatOutgoing(text) {
    return text;
  }
  // Fold every channelsConfig entry's channelId into access.channels, mirroring
  // DiscordBackend.readConfigAccess(). Read live so same-backend channel adds
  // apply without a restart. Falls back to initialAccess if the read throws.
  readConfigAccess() {
    try {
      const parsed = readSection("channels");
      const access = normalizeAccess(parsed.access ?? this.initialAccess);
      if (parsed.channelsConfig) {
        for (const entry of Object.values(parsed.channelsConfig)) {
          if (typeof entry === "object" && entry !== null) {
            const id = entry.channelId;
            if (id && !(id in access.channels)) {
              access.channels[id] = { requireMention: false, allowFrom: [] };
            }
          }
        }
      }
      return access;
    } catch {
      return this.initialAccess;
    }
  }
  loadAccess() {
    // The main chat is auto-allowed (single-source channel setup, mirrors
    // DiscordBackend.loadAccess) so a configured mainChannelId is enough for
    // both inbound gating and outbound. Base off the live config so all
    // configured channels (not just main) are seen without a restart.
    const a = this.readConfigAccess();
    if (this.mainChannelId && a && !(this.mainChannelId in (a.channels ?? {}))) {
      return { ...a, channels: { ...(a.channels ?? {}), [this.mainChannelId]: { allowFrom: [], requireMention: false } } };
    }
    return a;
  }
  _isAllowedChat(chatId) {
    const access = this.loadAccess();
    if (!access || access.dmPolicy === "disabled") return false;
    const key = String(chatId);
    if (this.mainChannelId && key === String(this.mainChannelId)) return true;
    if (key in (access.channels ?? {})) return true;
    if ((access.allowFrom ?? []).includes(key)) return true;
    return false;
  }
  // ── Bot API helper ─────────────────────────────────────────────────
  // POST <method> with a JSON body; parse the JSON envelope and normalize
  // Telegram's error shape into a thrown Error that carries `.status` and
  // `.retryAfter` so sendMessage's retry loop can key off them exactly like
  // the Discord backend keys off discord.js error fields.
  async _api(method, body, { signal } = {}) {
    const url = `${API_BASE}/bot${this.token}/${method}`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: signal ?? AbortSignal.timeout(30_000)
      });
    } catch (err) {
      // Network/timeout — surface as a transient error (no status).
      const e = err instanceof Error ? err : new Error(String(err));
      throw e;
    }
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok || !json || json.ok !== true) {
      const code = json?.error_code ?? res.status;
      const retryAfter = json?.parameters?.retry_after;
      const desc = json?.description ?? `HTTP ${res.status}`;
      const e = new Error(`telegram ${method} failed: ${desc}`);
      e.status = code;
      if (retryAfter != null) e.retryAfter = retryAfter;
      throw e;
    }
    return json.result;
  }
  // ── Lifecycle ──────────────────────────────────────────────────────
  async connect() {
    // Re-entry guard mirrors DiscordBackend.connect(): a second connect() while
    // one is in flight/settled returns the same promise (no duplicate loops).
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
      // Validate the token once (also surfaces a bad token early). getMe is
      // cheap and non-mutating; a failure here throws so startup can react.
      try {
        const me = await this._api("getMe", {});
        process.stderr.write(`mixdog telegram: connected as @${me?.username ?? me?.id ?? "?"}\n`);
      } catch (err) {
        this._connectPromise = null;
        throw err;
      }
      this._polling = true;
      // Fire-and-forget the poll loop; it self-reschedules until _polling clears.
      void this._pollLoop();
    })();
    return this._connectPromise;
  }
  async _pollLoop() {
    while (this._polling) {
      const ac = new AbortController();
      this._pollAbort = ac;
      // getUpdates long-poll: server holds up to `timeout`s; give the client
      // a slightly longer abort budget so a normal empty poll isn't aborted.
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        const updates = await this._api("getUpdates", {
          timeout: 25,
          offset: this._offset > 0 ? this._offset : undefined,
          allowed_updates: ["message"]
        }, { signal: ac.signal });
        clearTimeout(timer);
        if (Array.isArray(updates)) {
          for (const u of updates) {
            // Advance offset past every update we observe so none reprocesses,
            // even ones we ultimately drop (non-message / not allowlisted).
            if (typeof u.update_id === "number" && u.update_id >= this._offset) {
              this._offset = u.update_id + 1;
            }
            try { this._handleUpdate(u); } catch (e) {
              process.stderr.write(`mixdog telegram: handleUpdate failed: ${e}\n`);
            }
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (!this._polling) break; // disconnect() aborted us — exit quietly.
        // 409 = another getUpdates/webhook consumer is active; other errors are
        // transient. Back off and continue rather than crashing the loop.
        const status = err?.status;
        const backoff = status === 409 ? 5_000 : 2_000;
        process.stderr.write(`mixdog telegram: getUpdates error (${status ?? "net"}); retrying in ${backoff}ms\n`);
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        this._pollAbort = null;
      }
    }
  }
  _handleUpdate(u) {
    const msg = u.message;
    if (!msg) return; // non-message update (we only asked for messages).
    const chatId = msg.chat?.id;
    if (chatId == null) return;
    if (!this._isAllowedChat(chatId)) return;
    const from = msg.from ?? {};
    if (from.is_bot) return; // ignore bot echoes / other bots.
    const text = msg.text ?? msg.caption ?? "";
    const receivedAtMs = Date.now();
    // Mirror discord.mjs handleInbound's onMessage object shape so downstream
    // routing (resolveInboundRoute etc.) is backend-agnostic. Telegram has no
    // thread/parent concept here → parentChatId null; attachments unsupported
    // in scope 1 → [].
    if (this.onMessage) {
      this.onMessage({
        chatId: String(chatId),
        parentChatId: null,
        messageId: String(msg.message_id),
        receivedAtMs,
        discordCreatedAtMs: typeof msg.date === "number" ? msg.date * 1000 : null,
        user: from.username ?? [from.first_name, from.last_name].filter(Boolean).join(" ") ?? "user",
        userId: String(from.id ?? ""),
        text,
        ts: new Date((typeof msg.date === "number" ? msg.date * 1000 : receivedAtMs)).toISOString(),
        attachments: []
      });
    }
  }
  async disconnect() {
    this._polling = false;
    try { this._pollAbort?.abort(); } catch {}
    this._pollAbort = null;
    for (const interval of this._typingIntervals.values()) clearInterval(interval);
    this._typingIntervals.clear();
    this._connectPromise = null;
  }
  resetSendCount() {
    this.sendCount = 0;
  }
  // ── Outbound ───────────────────────────────────────────────────────
  // Mirrors DiscordBackend.sendMessage: OWNS chunking + per-chunk retry + the
  // opaque resume-token contract so output-forwarder (which passes whole text
  // and hands opts.resumeToken back on retry) works unchanged.
  async sendMessage(chatId, text, opts) {
    const limit = MAX_TELEGRAM_MESSAGE;
    // Chunk the RAW text, then guarantee every chunk stays within Telegram's
    // 4096 limit AFTER MarkdownV2 escaping. Escaping can up to ~double a chunk
    // (every special char gains a leading backslash), so a raw 4096 chunk of
    // specials would become ~8192 and Telegram rejects it with a 400 "message
    // is too long" (NOT a parse-entities error, so the parse fallback would not
    // catch it). We resplit any chunk whose converted form exceeds the limit,
    // halving the raw slice until the converted output fits. This keeps the
    // final `chunks` array authoritative for the resume-token index/length.
    const chunks = chunkForMarkdownV2(text, limit);
    // Opaque resume token. Shape parity with discord.mjs:
    // { hash, nextChunkIdx, sentIds, prefixed, limit }. Telegram has no
    // continuation-prefix requirement, so `prefixed` is always false — it is
    // emitted only so the token shape matches across backends.
    const contentHash = createHash("md5").update(String(text)).digest("hex");
    const resumeToken = opts?.resumeToken;
    let startIdx = 0;
    const sentIds = [];
    // Only honor the token when it pins to this exact text AND chunk limit;
    // otherwise the chunk boundaries could differ → full resend from 0 (safe).
    if (resumeToken && resumeToken.hash === contentHash && resumeToken.limit === limit) {
      startIdx = Math.max(0, Math.min(resumeToken.nextChunkIdx ?? 0, chunks.length));
      if (Array.isArray(resumeToken.sentIds)) sentIds.push(...resumeToken.sentIds);
    }
    try {
      for (let i = startIdx; i < chunks.length; i++) {
        // Per-chunk send with retry. On 429 honour Telegram's
        // parameters.retry_after (seconds → ms, clamp 60000); other transient
        // errors get a short backoff. Cap at 3 attempts; after the cap throw an
        // error carrying a resume token so the caller requeues the WHOLE item
        // and the next sendMessage resumes at this chunk index (no duplicates).
        let attempt = 0;
        for (;;) {
          try {
            // Convert THIS chunk to MarkdownV2 independently. Chunking happens
            // on raw text first (above), then each chunk is converted on its
            // own, so a MarkdownV2 entity can never span a chunk boundary →
            // every sent chunk is guaranteed to be independently valid.
            const md = toMarkdownV2(chunks[i]);
            let result;
            // Defensive length guard: chunkForMarkdownV2() already keeps every
            // chunk's converted form within limit, but a pathological slice at
            // the recursion floor could still exceed it. Rather than let
            // Telegram 400 with "message is too long" (which isParseEntitiesError
            // does NOT match, so the parse fallback below would be skipped and
            // the item would retry-loop forever), send this chunk as plain text.
            if (md.length > MAX_TELEGRAM_MESSAGE) {
              process.stderr.write(`mixdog telegram: converted chunk ${i} exceeds ${MAX_TELEGRAM_MESSAGE} after escaping; sending as plain text\n`);
              const plain = stripMdV2(md).slice(0, MAX_TELEGRAM_MESSAGE);
              result = await this._api("sendMessage", { chat_id: chatId, text: plain });
              sentIds.push(String(result?.message_id ?? ""));
              break;
            }
            try {
              result = await this._api("sendMessage", {
                chat_id: chatId,
                text: md,
                parse_mode: "MarkdownV2"
              });
            } catch (mdErr) {
              // Safety net: if the converter still produced something Telegram
              // rejects as unparseable, resend this chunk ONCE as plain text so
              // the user gets the content instead of a hard failure. Strip the
              // MarkdownV2 markers/escapes so no stray backslashes show.
              if (isParseEntitiesError(mdErr)) {
                process.stderr.write(`mixdog telegram: MarkdownV2 parse rejected, resending chunk ${i} as plain text\n`);
                result = await this._api("sendMessage", {
                  chat_id: chatId,
                  text: stripMdV2(md)
                });
              } else {
                throw mdErr;
              }
            }
            sentIds.push(String(result?.message_id ?? ""));
            break;
          } catch (err) {
            attempt++;
            const status = err?.status;
            // Classify: PERMANENT = a 4xx client error (chat not found 400,
            // unauthorized 401, blocked 403, 404 …) that will never succeed on
            // retry. TRANSIENT = 429, any 5xx, or network/timeout (no status).
            // A permanent error must NOT retry-loop and must NOT carry a resume
            // token — throw it immediately flagged so the forwarder drops the
            // item instead of requeuing forever. (MarkdownV2 parse-entity 400s
            // are already handled by the plain-text fallback above and never
            // reach here.)
            const isPermanent = typeof status === "number" && status >= 400 && status < 500 && status !== 429;
            if (isPermanent) {
              const e = err instanceof Error ? err : new Error(String(err));
              e.permanent = true;
              throw e;
            }
            if (attempt >= 3) {
              const e = err instanceof Error ? err : new Error(String(err));
              e.resumeToken = { hash: contentHash, nextChunkIdx: i, sentIds: [...sentIds], prefixed: false, limit };
              throw e;
            }
            if (status === 429) {
              // Telegram's parameters.retry_after is ALWAYS in SECONDS, so
              // convert seconds→ms. Clamp to [0, 60000]; fall back to 1s when
              // the field is absent/invalid.
              const retryAfterMs = Number(err?.retryAfter) * 1000;
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
      // persist it on the queue item and resume on retry (matches discord.mjs).
      if (err?.resumeToken) wrapped.resumeToken = err.resumeToken;
      // Propagate the permanent flag so the forwarder drops (not requeues) it.
      if (err?.permanent) wrapped.permanent = true;
      throw wrapped;
    }
    return { sentIds };
  }
  // Telegram supports message reactions via setMessageReaction. Best-effort:
  // an emoji Telegram doesn't allow as a reaction 400s → swallow (non-critical).
  async react(chatId, messageId, emoji) {
    try {
      await this._api("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: [{ type: "emoji", emoji }]
      });
    } catch { /* reactions are non-critical */ }
  }
  async removeReaction(chatId, messageId, _emoji) {
    try {
      await this._api("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: []
      });
    } catch { /* best-effort */ }
  }
  // Bot API cannot read arbitrary chat history (no getChatHistory for bots);
  // return [] so callers that expect a list degrade gracefully.
  async fetchMessages() {
    return [];
  }
  // editMessageText exists; kept minimal for scope-1 parity so index.mjs's
  // edit path doesn't throw. Sends the first chunk's worth only (no overflow
  // management like Discord's editOverflow — a later scope can extend this).
  async editMessage(chatId, messageId, text, _opts) {
    try {
      const result = await this._api("editMessageText", {
        chat_id: chatId,
        message_id: Number(messageId),
        text: chunk(text, MAX_TELEGRAM_MESSAGE)[0] ?? ""
      });
      return String(result?.message_id ?? messageId);
    } catch {
      return String(messageId);
    }
  }
  async deleteMessage(chatId, messageId) {
    try {
      await this._api("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
    } catch { /* best-effort */ }
  }
  // Attachment download is unsupported in scope 1. getFile + a download step
  // can be added later; returning [] keeps the call site safe meanwhile.
  async downloadAttachment() {
    return [];
  }
  async validateChannel(chatId) {
    // getChat confirms the bot can see the chat; throws (like Discord's
    // fetchAllowedChannel) when it can't.
    await this._api("getChat", { chat_id: chatId });
  }
  // ── Typing indicator ───────────────────────────────────────────────
  // sendChatAction "typing" lasts ~5s server-side, so refresh on an interval
  // while active — mirrors DiscordBackend.startTyping's interval model.
  startTyping(channelId) {
    this.stopTyping(channelId);
    const fire = () => {
      void this._api("sendChatAction", { chat_id: channelId, action: "typing" }).catch(() => {});
    };
    fire();
    const interval = setInterval(fire, 4_000);
    this._typingIntervals.set(String(channelId), interval);
  }
  stopTyping(channelId) {
    const key = String(channelId);
    const interval = this._typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this._typingIntervals.delete(key);
    }
  }
}

export {
  TelegramBackend,
  MAX_TELEGRAM_MESSAGE
};
