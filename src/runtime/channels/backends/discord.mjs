
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
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync
} from "fs";
import { join, sep } from "path";
import { createHash } from "crypto";
import { chunk, formatForDiscord, MAX_DISCORD_MESSAGE } from "../lib/format.mjs";
import { withConfigLock } from "../lib/config-lock.mjs";
import { readSection, updateSection } from "../../shared/config.mjs";
const MAX_CHUNK_LIMIT = MAX_DISCORD_MESSAGE;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const RECENT_SENT_CAP = 200;
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
    // Legacy "pairing" policy was removed (its approval flow was never
    // completable); normalize it to "allowlist" on load.
    dmPolicy: parsed?.dmPolicy === "pairing" ? "allowlist" : (parsed?.dmPolicy ?? defaults.dmPolicy),
    allowFrom: parsed?.allowFrom ?? defaults.allowFrom,
    channels: parsed?.channels ?? defaults.channels,
    mentionPatterns: parsed?.mentionPatterns,
    // Setup UI historically saved a boolean toggle; runtime needs an emoji
    // string for msg.react(). true → default emoji, non-string → off.
    ackReaction: parsed?.ackReaction === true
      ? "✅"
      : (typeof parsed?.ackReaction === "string" && parsed.ackReaction ? parsed.ackReaction : undefined),
    replyToMode: parsed?.replyToMode,
    textChunkLimit: parsed?.textChunkLimit,
  };
}
function safeAttName(att) {
  return (att.name ?? att.id).replace(/[\[\]\r\n;]/g, "_");
}
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
  typingIntervals = /* @__PURE__ */ new Map();
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
  // ── Lifecycle ──────────────────────────────────────────────────────
  async connect() {
    // Re-entry guard: if a connect() is already in-flight or completed, return
    // the same promise / no-op so concurrent ownership-timer fires cannot
    // overwrite this.client, duplicate listeners, or trigger duplicate logins.
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connectInner().catch((err) => {
      this._connectPromise = null;
      throw err;
    });
    return this._connectPromise;
  }
  async _connectInner() {
    await this._buildClient();
    this._applyStaticAccessOverride();
    this._registerEventListeners();
    this._registerSlashCommands();
    this._registerShardListeners();
    try {
      await this._awaitLogin();
    } catch (err) {
      // Destroy the partial Client to free the listeners/handles it already
      // attached. Without this, a ready-timeout retry leaks every listener
      // set by _registerEventListeners/_registerSlashCommands/_registerShardListeners.
      try { this.client?.destroy?.(); } catch {}
      this.client = null;
      throw err;
    }
    this.persistAccessFromChannelsConfig();
  }
  async _buildClient() {
    const { Client, GatewayIntentBits, Partials } = await ensureDiscord();
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel]
    });
  }
  _applyStaticAccessOverride() {
    if (this.isStatic) {
      this.bootAccess = this.loadAccess();
    }
  }
  _registerEventListeners() {
    this.client.on("error", (err) => {
      process.stderr.write(`mixdog discord: client error: ${err}
`);
    });
    this.client.on("messageCreate", (msg) => {
      if (msg.author.id === this.client.user?.id) {
        return;
      }
      if (msg.author.bot) return;
      this.handleInbound(msg, Date.now()).catch(
        (e) => process.stderr.write(`mixdog discord: handleInbound failed: ${e}
`)
      );
    });
    this.client.on("interactionCreate", async (interaction) => {
      try {
        // Trust gate for interactions. Buttons / selects / modal submits used to
        // reach onInteraction / onModalRequest without passing through the
        // message gate(), so a configured allowFrom never applied to them
        // (schedule/quiet/profile modals + perm approvals were openable by any
        // user in the channel). Apply the same allowFrom decision here; an empty
        // allowFrom stays open so current configs are unaffected.
        if (!this._interactionAllowed(interaction.channelId ?? "", interaction.user?.id, interaction)) {
          try {
            if (typeof interaction.reply === "function" && !interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: "⛔ Not authorized for this action.", ephemeral: true });
            } else if (typeof interaction.deferUpdate === "function") {
              await interaction.deferUpdate();
            }
          } catch {}
          return;
        }
        if (interaction.isChatInputCommand() && interaction.commandName === "stop") {
          await interaction.reply({ content: "\u23F9 Stopping...", ephemeral: true });
          if (this.onInteraction) {
            this.onInteraction({
              type: "button",
              customId: "stop_task",
              userId: interaction.user.id,
              channelId: interaction.channelId ?? ""
            });
          }
          return;
        }
        if (interaction.isModalSubmit()) {
          if (this.onInteraction) {
            const fields = {};
            for (const row of interaction.components) {
              for (const comp of row.components ?? []) {
                if (comp.customId && comp.value != null) fields[comp.customId] = String(comp.value);
              }
            }
            this.onInteraction({
              type: "modal",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId ?? "",
              fields,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
          await interaction.deferUpdate().catch(() => {
          });
          return;
        }
        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isChannelSelectMenu()) {
          const needsModal = interaction.isButton() && (interaction.customId === "sched_add_next" || interaction.customId === "sched_edit_next" || interaction.customId === "quiet_set_next" || interaction.customId === "activity_add_next" || interaction.customId === "profile_edit");
          if (needsModal) {
            if (this.onModalRequest) {
              await Promise.resolve(this.onModalRequest(interaction)).catch((err) => {
                process.stderr.write(`mixdog discord: onModalRequest failed: ${err}\n`);
              });
            }
            return;
          }
          await interaction.deferUpdate().catch(() => {
          });
          if (this.onInteraction) {
            this.onInteraction({
              type: interaction.isButton() ? "button" : "select",
              customId: interaction.customId,
              userId: interaction.user.id,
              channelId: interaction.channelId,
              values: interaction.isStringSelectMenu() ? interaction.values : void 0,
              message: interaction.message ? { id: interaction.message.id } : void 0
            });
          }
        }
      } catch (err) {
        process.stderr.write(`mixdog discord: interaction error: ${err}
`);
      }
    });
  }
  _registerSlashCommands() {
    this.client.on(_discord.Events.ClientReady, async (c) => {
      process.stderr.write(`mixdog discord: gateway connected as ${c.user.tag}
`);
      try {
        // Plugin registers no global commands; clear the global slot so any
        // pre-existing entry from prior installs is not surfaced to users.
        await c.application?.commands.set([]);
        process.stderr.write(`mixdog discord: global application commands cleared
`);

        // Replace each guild's command set with just /stop. set() overwrites,
        // so the desired set is the only one that survives.
        const desiredCommands = [
          { name: "stop", description: "Stop the current Mixdog response" },
        ];
        for (const [guildId] of c.guilds.cache) {
          await c.application?.commands.set(desiredCommands, guildId);
        }
        // Register /stop globally so it is available in DM bridge contexts
        // where there is no guild scope.
        try {
          await c.application?.commands.set(desiredCommands);
        } catch (e) {
          process.stderr.write(`mixdog discord: global /stop register failed: ${e?.message}\n`);
        }
        process.stderr.write(`mixdog discord: /stop command registered (${c.guilds.cache.size} guild(s))
`);
      } catch (err) {
        process.stderr.write(`mixdog discord: slash command registration failed: ${err}
`);
      }
    });
  }
  _registerShardListeners() {
    this.client.on("shardDisconnect", (ev, id) => {
      process.stderr.write(`mixdog discord: shard ${id} disconnected (code ${ev.code}). Will auto-reconnect.
`);
    });
    this.client.on("shardReconnecting", (id) => {
      process.stderr.write(`mixdog discord: shard ${id} reconnecting...
`);
    });
    this.client.on("shardResume", (id, replayedEvents) => {
      process.stderr.write(`mixdog discord: shard ${id} resumed (replayed ${replayedEvents} events)
`);
    });
    this.client.on("warn", (msg) => {
      process.stderr.write(`mixdog discord: warn: ${msg}
`);
    });
  }
  async _awaitLogin() {
    let readyTimeout;
    const readyPromise = new Promise((resolve, reject) => {
      readyTimeout = setTimeout(() => reject(new Error("discord ready timeout (30s)")), 3e4);
      this.client.once(_discord.Events.ClientReady, () => {
        clearTimeout(readyTimeout);
        resolve();
      });
    });
    try {
      await this.client.login(this.token);
    } catch (err) {
      clearTimeout(readyTimeout);
      throw err;
    }
    await readyPromise;
  }
  async disconnect() {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    if (this.client) this.client.destroy();
    this._connectPromise = null;
  }
  resetSendCount() {
    this.sendCount = 0;
  }
  startTyping(channelId) {
    this.stopTyping(channelId);
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
  async sendMessage(chatId, text, opts) {
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
          try {
            const sent = await ch.send(payload);
            this.noteSent(sent.id);
            sentIds.push(sent.id);
            break;
          } catch (err) {
            attempt++;
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
            if (attempt >= 3) {
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
  async downloadAttachment(chatId, messageId) {
    const ch = await this.fetchAllowedChannel(chatId);
    const msg = await ch.messages.fetch(messageId);
    if (msg.attachments.size === 0) return [];
    const results = [];
    for (const att of msg.attachments.values()) {
      const path = await this.downloadSingleAttachment(att);
      results.push({
        id: att.id,
        path,
        name: safeAttName(att),
        contentType: att.contentType ?? "unknown",
        size: att.size
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
  persistAccessFromChannelsConfig() {
    if (this.isStatic || !this.configFile) return;
    try {
      const parsed = readSection("channels");
      if (!parsed.channelsConfig) return;
      const access = normalizeAccess(parsed.access);
      let changed = false;
      for (const entry of Object.values(parsed.channelsConfig)) {
        if (typeof entry === "object" && entry !== null) {
          const id = entry.channelId;
          if (id && !(id in access.channels)) {
            access.channels[id] = { requireMention: false, allowFrom: [] };
            changed = true;
          }
        }
      }
      if (changed) this.saveAccess(access);
    } catch (err) {
      process.stderr.write(`mixdog discord: persistAccessFromChannelsConfig failed: ${err}\n`);
    }
  }
  loadAccess() {
    const a = this.bootAccess ?? this.readConfigAccess();
    // Single-source channel setup: auto-allow the configured main channel so
    // both inbound (gate) and outbound (fetchAllowedChannel) accept it from a
    // single channelsConfig.main.channelId — no separate access.channels entry.
    // An explicit entry for the same channel is preserved (not overwritten).
    if (this.mainChannelId && a && !(this.mainChannelId in (a.channels ?? {}))) {
      return { ...a, channels: { ...(a.channels ?? {}), [this.mainChannelId]: { allowFrom: [], requireMention: false } } };
    }
    return a;
  }
  saveAccess(a) {
    if (this.isStatic) return;
    if (!this.configFile) return;
    return withConfigLock(() => {
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
      updateSection("channels", (channels) => ({
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
      // gate() above), but routing also needs the parent id to find labels/
      // modes in channelsConfig. Surface parentChatId so resolveInboundRoute
      // can fall back to the parent when the thread id has no entry.
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
    const ch = await this.client.channels.fetch(id);
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
  async downloadSingleAttachment(att) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`
      );
    }
    const res = await fetch(att.url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) {
      throw new Error(`attachment download failed: HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new Error(`attachment download returned empty body: ${att.name ?? att.id}`);
    }
    // Stream the response so an oversized payload is aborted before the
    // full body lands in memory. Buffering via arrayBuffer() first would
    // already exceed MAX_ATTACHMENT_BYTES by the time we checked length.
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > MAX_ATTACHMENT_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error(
            `attachment payload too large: exceeded ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB while streaming (${att.name ?? att.id})`
          );
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    if (received === 0) {
      throw new Error(`attachment download returned empty buffer: ${att.name ?? att.id}`);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), received);
    if (att.size > 0 && buf.length !== att.size) {
      process.stderr.write(`mixdog discord: attachment size mismatch: expected ${att.size} got ${buf.length} (${att.name ?? att.id})\n`);
    }
    const name = att.name ?? `${att.id}`;
    const rawExt = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const safeId = String(att.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    mkdirSync(this.inboxDir, { recursive: true });
    const candidate = join(this.inboxDir, `${Date.now()}-${safeId}.${ext}`);
    const resolvedInbox = realpathSync(this.inboxDir);
    if (!candidate.startsWith(resolvedInbox + sep)) {
      throw new Error(`attachment path traversal rejected: ${candidate}`);
    }
    writeFileSync(candidate, buf);
    return candidate;
  }
}
export {
  DiscordBackend
};
