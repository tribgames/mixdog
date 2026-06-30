import { existsSync, statSync, watch, openSync, readSync, closeSync } from "fs";
import { createHash } from "crypto";
import { formatForDiscord, chunk, safeCodeBlock } from "./format.mjs";
import { dropTrace, _dtPreview } from "./drop-trace.mjs";
import {
  formatToolSurface,
  isExplorerSurface,
  isMemorySurface,
} from "../../shared/tool-surface.mjs";
import {
  cwdToProjectSlug,
  discoverCurrentClaudeSession,
  listInteractiveClaudeSessions,
  getLatestInteractiveClaudeSession
} from "./session-discovery.mjs";
import {
  findLatestTranscriptByMtime,
  sameResolvedPath,
  detectCurrentSessionTranscript,
  discoverSessionBoundTranscript
} from "./transcript-discovery.mjs";
import {
  SKIP_TEXTS,
  HIDDEN_TOOLS,
  isRecallMemory,
  isMemoryFile,
  buildDedupKey,
  buildToolLine
} from "./tool-format.mjs";

class OutputForwarder {
  ownerGetter = null;
  setOwnerGetter(fn) {
    this.ownerGetter = fn;
  }
  _isOwner() {
    if (!this.ownerGetter) return true;
    // Fail closed: a probe exception must NOT be treated as ownership.
    // Forwarding transcript output from a non-owner duplicates Discord
    // sends from the previous owner process.
    try { return !!this.ownerGetter(); } catch { return false; }
  }
  constructor(cb, statusState) {
    this.cb = cb;
    this.statusState = statusState;
    this._persistTimer = null;
    this._pendingPersistData = null;
    // Best-effort final flush on process exit. The handler is sync (writeFileSync
    // + fsyncSync inside updateState), so it actually lands on graceful exit.
    // SIGTERM/SIGINT shutdowns that bypass 'exit' are covered by the timer
    // unref-ing so the event loop drains it before close.
    process.on('exit', () => { try { this._flushPersistState(); } catch {} });
  }
  lastHash = "";
  sentCount = 0;
  transcriptPath = "";
  channelId = "";
  userMessageId = "";
  emoji = "";
  lastFileSize = 0;
  readFileSize = 0;
  watchingPath = "";
  watcher = null;
  idleTimer = null;
  onIdleCallback = null;
  inExplorerSequence = false;
  inRecallSequence = false;
  hasSeenAssistant = false;
  sending = false;
  sendRetryTimer = null;
  // Priority-lane queues (Tier3 split).
  // finalLane  — text items (transcript text, final answer segments)
  // streamLane — tool-log / progress items
  // drainQueue() picks from finalLane first so final answers are never blocked
  // behind a batch of tool-log messages.
  finalLane = [];
  streamLane = [];
  // Cap streamLane length under sustained backpressure (Discord 429 storm,
  // network outage). When over the cap, the oldest text item is merged
  // into the next pending text payload so we don't grow unbounded but
  // also don't lose content.
  static SEND_QUEUE_MAX = 200;
  // Persisted final-flush ledger so a forwarder restart can resume final
  // forwarding instead of giving up after 5 short retries.
  pendingFinalFlush = false;
  mainSessionId = "";
  watchDebounce = null;
  turnTextBuffer = "";
  hasBinding() {
    return !!this.transcriptPath;
  }
  /** Set context for current turn (called on user message) */
  setContext(channelId, transcriptPath, options = {}) {
    this.channelId = channelId;
    if (!transcriptPath) return;
    if (this.transcriptPath && !existsSync(this.transcriptPath)) {
      const relocated = detectCurrentSessionTranscript()?.transcriptPath ?? findLatestTranscriptByMtime();
      if (relocated) {
        transcriptPath = relocated;
      }
    }
    if (this.transcriptPath !== transcriptPath) {
      this.closeWatcher();
      dropTrace("context.transcriptPath.change", { sessionId: this.mainSessionId || "(none)", oldPath: this.transcriptPath || "(none)", newPath: transcriptPath });
      this.transcriptPath = transcriptPath;
      this.mainSessionId = "";
      this.sentCount = 0;
      this.lastHash = "";
      this.turnTextBuffer = "";
    }
    try {
      const stat = existsSync(this.transcriptPath) ? statSync(this.transcriptPath) : null;
      const currentSize = stat?.size ?? 0;
      let fileSize;
      if (options.replayFromStart) {
        fileSize = 0;
      } else if (options.catchUpFromPersisted) {
        const persisted = this.statusState?.read?.();
        const persistedSize = typeof persisted?.lastFileSize === "number" ? persisted.lastFileSize : -1;
        const sameTranscript = persisted?.transcriptPath &&
          sameResolvedPath(persisted.transcriptPath, this.transcriptPath);
        fileSize = (sameTranscript && persistedSize >= 0)
          ? Math.min(Math.max(persistedSize, 0), currentSize)
          : currentSize;
      } else {
        fileSize = currentSize;
      }
      this.lastFileSize = fileSize;
      this.readFileSize = fileSize;
    } catch {
      this.lastFileSize = 0;
      this.readFileSize = 0;
    }
  }
  /** Reset counters for new turn */
  reset() {
    this.sentCount = 0;
    this.lastHash = "";
    this.inExplorerSequence = false;
    this.inRecallSequence = false;
    this.hasSeenAssistant = false;
    this.turnTextBuffer = "";
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  /** Read new bytes from transcript file since readFileSize */
  readNewLines() {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
      return { lines: [], nextFileSize: this.readFileSize };
    }
    let fd = null;
    try {
      const stat = this._pendingStat ?? statSync(this.transcriptPath);
      this._pendingStat = null;
      if (stat.size <= this.readFileSize) {
        return { lines: [], nextFileSize: this.readFileSize };
      }
      const startOffset = this.readFileSize;
      fd = openSync(this.transcriptPath, "r");
      const buf = Buffer.alloc(stat.size - startOffset);
      readSync(fd, buf, 0, buf.length, startOffset);
      // Only advance readFileSize to the last newline boundary. A trailing
      // partial line (writer still appending) must be re-read next tick;
      // otherwise the parse-failed slice is silently consumed forever.
      const lastNl = buf.lastIndexOf(0x0a);
      const consumed = lastNl >= 0 ? lastNl + 1 : 0;
      const nextFileSize = startOffset + consumed;
      this.readFileSize = nextFileSize;
      const text = consumed > 0 ? buf.slice(0, consumed).toString("utf8") : "";
      return {
        lines: text ? text.split("\n").filter((l) => l.trim()) : [],
        nextFileSize
      };
    } catch {
      return { lines: [], nextFileSize: this.readFileSize };
    } finally {
      if (fd != null) {
        closeSync(fd);
      }
    }
  }
  /** Track last tool_use name and file path for matching with tool_result */
  lastToolName = "";
  lastToolFilePath = "";
  /** Extract new assistant text + tool logs from transcript since readFileSize */
  extractNewText() {
    const { lines: newLines, nextFileSize } = this.readNewLines();
    let newText = "";
    for (const l of newLines) {
      try {
        const entry = JSON.parse(l);
        if (!entry.isSidechain && entry.sessionId && !this.mainSessionId) {
          this.mainSessionId = entry.sessionId;
        }
        if (entry.isSidechain) continue;
        if (this.mainSessionId && entry.sessionId && entry.sessionId !== this.mainSessionId) continue;
        if (entry.type === "user" && entry.message?.content?.some((c) => c.type === "tool_result")) {
          if (OutputForwarder.isRecallMemory(this.lastToolName)) {
            continue;
          }
          if (this.lastToolName === "Edit" && entry.toolUseResult && !OutputForwarder.isMemoryFile(this.lastToolFilePath)) {
            const old = entry.toolUseResult.oldString || "";
            const nw = entry.toolUseResult.newString || "";
            if (old || nw) {
              const diffLines = [];
              for (const l2 of old.split("\n")) diffLines.push("- " + l2);
              for (const l2 of nw.split("\n")) diffLines.push("+ " + l2);
              const shown = diffLines.slice(0, 15);
              let diffContent = shown.join("\n");
              if (diffLines.length > 15) diffContent += "\n... +" + (diffLines.length - 15) + " lines";
              const block = safeCodeBlock(diffContent, "diff");
              newText += block + "\n";
            }
          }
          continue;
        }
        if (entry.type === "assistant" && entry.message?.content) {
          this.hasSeenAssistant = true;
          const parts = [];
          for (const c of entry.message.content) {
            if (c.type === "text" && c.text?.trim()) {
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              let cleaned = OutputForwarder.stripForeignWorkerChannels(c.text.trim());
              cleaned = cleaned.replace(/<(memory-context|system-reminder|event)\b[^>]*>[\s\S]*?<\/\1>/gi, "").trim();
              if (cleaned) parts.push(cleaned);
            } else if (c.type === "tool_use") {
              this.lastToolName = c.name || "";
              this.lastToolFilePath = c.input?.file_path || "";
              if (OutputForwarder.isHidden(c.name)) continue;
              const surface = formatToolSurface(c.name, c.input, { max: 50 });
              if (isExplorerSurface(surface.label)) {
                if (!this.inExplorerSequence) {
                  this.inExplorerSequence = true;
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **Explorer** (" + (surface.summary || surface.label) + ")");
                }
                continue;
              }
              if (isMemorySurface(surface.label)) {
                if (!this.inRecallSequence) {
                  this.inRecallSequence = true;
                  if (parts.length > 0) parts.push("");
                  parts.push("\u25CF **Memory**");
                }
                continue;
              }
              this.inExplorerSequence = false;
              this.inRecallSequence = false;
              const toolLine = OutputForwarder.buildToolLine(c.name, c.input);
              if (toolLine) {
                if (parts.length > 0) parts.push("");
                parts.push(toolLine);
              }
            }
          }
          if (parts.length) newText += parts.join("\n") + "\n";
        }
      } catch {
      }
    }
    return { text: newText.trim(), nextFileSize };
  }
  // ── Single-send gate ──────────────────────────────────────────────
  // All Discord sends pass through sendOnce() so duplicate concurrent sends are avoided.
  // Texts that should never be forwarded to Discord (Claude's internal status lines)
  static SKIP_TEXTS = SKIP_TEXTS;
  commitReadProgress(nextFileSize) {
    if (nextFileSize <= this.lastFileSize) return;
    this.lastFileSize = nextFileSize;
    this.persistState();
  }
  async deliverQueueItem(item) {
    const targetChannelId = item.channelId ?? this.channelId;
    if (!item.text || !targetChannelId) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    if (!item.skipHashDedup && OutputForwarder.SKIP_TEXTS.has(item.text.trim())) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const formatted = item.preformatted ? item.text : formatForDiscord(item.text);
    const hash = item.skipHashDedup
      ? ""
      : item.dedupKey
        ? item.dedupKey
        : createHash("md5").update(formatted).digest("hex");
    if (!item.skipHashDedup && this.lastHash === hash) {
      this.commitReadProgress(item.nextFileSize);
      return;
    }
    const chunks = chunk(formatted, 2e3);
    const _t0Send = Date.now();
    // Resume from _nextChunkIdx if this item is being retried after a partial send.
    // This avoids re-sending chunks that already landed successfully.
    if (item._chunks === undefined) {
      item._chunks = chunks;
      item._nextChunkIdx = 0;
      item._sendRetries = 0;
    }
    for (let _ci = item._nextChunkIdx; _ci < item._chunks.length; _ci++) {
      const c = item._chunks[_ci];
      try {
        await this.cb.send(targetChannelId, c);
        item._nextChunkIdx = _ci + 1;
        dropTrace("discord.send.ok", null);
      } catch (err) {
        // Discord 429 or transient error — honour Retry-After then re-throw so
        // drainQueue's retry loop calls deliverQueueItem again. Chunk progress
        // is stored on item so we resume from the failed chunk, not chunk 0.
        const status = err?.status ?? err?.code ?? err?.httpStatus;
        const retryAfter = err?.retryAfter ?? err?.retry_after
          ?? err?.headers?.["retry-after"] ?? err?.response?.headers?.["retry-after"];
        dropTrace("discord.send.err", { channelId: this.channelId, chunkIndex: _ci, status, retryAfter: retryAfter ?? "(none)", err: String(err) });
        item._sendRetries = (item._sendRetries || 0) + 1;
        if (item._sendRetries >= 3) {
          // Cap retries to avoid infinite duplicate loop — give up on this item
          process.stderr.write(`[output-forwarder] chunk send exceeded 3 retries at chunk ${_ci}, dropping item\n`);
          item._nextChunkIdx = item._chunks.length; // mark exhausted
          return;
        }
        if (status === 429) {
          if (retryAfter != null) {
            const ms = Number(retryAfter) > 1000 ? Number(retryAfter) : Number(retryAfter) * 1000;
            if (Number.isFinite(ms) && ms > 0) {
              await new Promise((r) => setTimeout(r, Math.min(ms, 60_000)));
            }
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
        throw err;
      }
    }
    if (!item.skipHashDedup) {
      this.lastHash = hash;
    }
    const _bt = typeof item.bufferText === 'string' ? item.bufferText : '';
    if (_bt.trim()) {
      this.turnTextBuffer = this.turnTextBuffer ? `${this.turnTextBuffer}

${_bt.trim()}` : _bt.trim();
    }
    this.sentCount += chunks.length;
    this.commitReadProgress(item.nextFileSize);
  }
  scheduleRetry() {
    if (this.sendRetryTimer) return;
    dropTrace("drain.retry.schedule", { finalLen: this.finalLane.length, streamLen: this.streamLane.length });
    this.sendRetryTimer = setTimeout(() => {
      this.sendRetryTimer = null;
      this._kickDrain();
    }, 1e3);
  }
  /** Forward new assistant text to Discord. Returns true if text was sent. */
  async forwardNewText() {
    if (!this._isOwner()) return false;
    if (!this.channelId) return false;
    const { text: newText, nextFileSize } = this.extractNewText();
    if (!newText) {
      if (!this.sending && this.finalLane.length === 0 && this.streamLane.length === 0) {
        this.commitReadProgress(nextFileSize);
      }
      return false;
    }
    // Coalesce back-to-back text items BEFORE drain/chunking so adjacent
    // emits merge into one chunk pass rather than waiting for SEND_QUEUE_MAX.
    // tool-log items stay separate (preformatted) so we only merge plain-text.
    // Issue 1: if drain is in flight finalLane[0] is being delivered; coalescing
    // into that slot causes a concurrent mutation race.  Only coalesce into the
    // tail of finalLane when it is not the item currently being drained.
    // finalLane[0] is being drained when this.sending; coalesce into tail only
    // when tail is not index 0 (i.e. length >= 2) or drain is not in flight.
    const ftLen = this.finalLane.length;
    const ftTail = (ftLen > 0 && !(this.sending && ftLen === 1))
      ? this.finalLane[ftLen - 1] : null;
    if (ftTail) {
      ftTail.text = `${ftTail.text}\n\n${newText}`;
      ftTail.bufferText = `${ftTail.bufferText}\n\n${newText}`;
      ftTail.nextFileSize = nextFileSize;
      this._kickDrain();
      return true;
    }
    // Cap-and-merge backpressure guard on finalLane: when saturated, fold
    // the new text into the trailing finalLane item.
    if (this.finalLane.length >= OutputForwarder.SEND_QUEUE_MAX) {
      // Skip index 0 while drain is in flight (same race guard as above).
      const capEnd = this.sending ? 1 : 0;
      for (let i = this.finalLane.length - 1; i >= capEnd; i--) {
        const cap = this.finalLane[i];
        cap.text = `${cap.text}\n\n${newText}`;
        cap.bufferText = `${cap.bufferText}\n\n${newText}`;
        cap.nextFileSize = nextFileSize;
        this._kickDrain();
        return true;
      }
    }
    this.finalLane.push({
      type: "text",
      text: newText,
      nextFileSize,
      bufferText: newText
    });
    this._kickDrain();
    return true;
  }
  /** Forward tool log line to Discord */
  async forwardToolLog(toolLine, toolName, toolInput) {
    if (!this._isOwner()) return;
    if (!this.channelId) return;
    // Issue 2: do NOT advance readFileSize here via stat.  The stat'd size
    // could jump past bytes that forwardNewText has not yet parsed, causing
    // extractNewText/readNewLines to skip real content.  readFileSize is
    // advanced only inside readNewLines once bytes are actually consumed.
    this.streamLane.push({
      type: "toolLog",
      text: toolLine,
      nextFileSize: this.readFileSize,
      preformatted: true,
      dedupKey: OutputForwarder.buildDedupKey(toolName, toolInput)
    });
    this._kickDrain();
  }
  /** Centralised fire-and-forget drainQueue with rejection guard. */
  _kickDrain() {
    this.drainQueue().catch(err => process.stderr.write(`[output-forwarder] drainQueue rejected: ${err?.message || err}\n`));
  }
  /** Drain both priority lanes sequentially. finalLane drains first when non-empty. */
  async drainQueue() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.finalLane.length > 0 || this.streamLane.length > 0) {
        // Pick from finalLane first; fall back to streamLane.
        const fromFinal = this.finalLane.length > 0;
        const lane = fromFinal ? this.finalLane : this.streamLane;
        const item = lane[0];
        try {
          if (item.type === "text") {
            await this.deliverQueueItem(item);
          } else if (item.type === "toolLog") {
            await this.processToolLog(item);
          }
          lane.shift();
        } catch (err) {
          process.stderr.write(`mixdog: send failed: ${err}
`);
          dropTrace("drain.send.err", { finalLen: this.finalLane.length, streamLen: this.streamLane.length, lane: fromFinal ? "final" : "stream", itemType: item?.type, err: String(err) });
          this.scheduleRetry();
          break;
        }
      }
    } finally {
      this.sending = false;
    }
  }
  /** Internal: process a single tool log send (extracted from old forwardToolLog) */
  async processToolLog(item) {
    if (this.userMessageId) {
      const newEmoji = "\u{1F6E0}\uFE0F";
      try {
        if (this.emoji && this.emoji !== newEmoji) {
          await this.cb.removeReaction(this.channelId, this.userMessageId, this.emoji);
        }
        await this.cb.react(this.channelId, this.userMessageId, newEmoji);
        this.emoji = newEmoji;
      } catch {
      }
    }
    await this.deliverQueueItem(item);
  }
  /** Forward final text on session idle */
  async forwardFinalText(retries = 0, pinnedChannelId = null) {
    if (!this._isOwner()) return;
    // Pin the target channel at call time so a rebind to a new turn's channel
    // (which mutates this.channelId synchronously after this fire-and-forget
    // call returns) cannot redirect the previous turn's final output to the
    // wrong channel.
    const channelId = pinnedChannelId ?? this.channelId;
    if (!channelId) return;
    if (this.sending || this.finalLane.length > 0 || this.streamLane.length > 0) {
      // Mark a durable flush request so a process restart picks it up
      // instead of dropping the final frame on the floor.
      try {
        this.pendingFinalFlush = true;
        this.updateState((state) => { state.pendingFinalFlush = true; });
      } catch {}
      if (retries < 5) {
        setTimeout(() => void this.forwardFinalText(retries + 1, channelId), 300);
      } else {
        dropTrace("drain.finalText.exhausted", { retries, finalLen: this.finalLane.length, streamLen: this.streamLane.length, sending: this.sending });
        // Past the short-retry budget: schedule a longer-tail drain wait so
        // the final frame still ships once the queue empties, instead of
        // silently giving up.
        const waitDrain = () => {
          if (!this.sending && this.finalLane.length === 0 && this.streamLane.length === 0) {
            void this.forwardFinalText(0, channelId);
            return;
          }
          setTimeout(waitDrain, 1000);
        };
        setTimeout(waitDrain, 1000);
      }
      return;
    }
    this.sending = true;
    try {
      if (this.userMessageId && this.emoji) {
        try {
          await this.cb.removeReaction(channelId, this.userMessageId, this.emoji);
        } catch {
        }
      }
      const { text: newText, nextFileSize } = this.extractNewText();
      if (newText) {
        const finalItem = { type: "text", text: newText, nextFileSize, bufferText: newText, channelId };
        try {
          await this.deliverQueueItem(finalItem);
        } catch (err) {
          // Transient send failure: extractNewText already advanced the read
          // cursor past these bytes, so dropping the item here would lose the
          // final text. Requeue it (it retains per-chunk send progress) and let
          // drainQueue retry instead of silently discarding. pendingFinalFlush
          // stays set so a process restart can also resume the flush.
          this.finalLane.push(finalItem);
          this.scheduleRetry();
          return;
        }
      } else {
        this.commitReadProgress(nextFileSize);
      }
      if (this.turnTextBuffer.trim()) {
        await this.cb.recordAssistantTurn?.({
          channelId,
          text: this.turnTextBuffer.trim(),
          sessionId: this.mainSessionId || void 0
        });
        this.turnTextBuffer = "";
      }
      // Clear the durable flush marker only after delivery succeeded so a
      // throw above leaves pendingFinalFlush=true and a process restart
      // can resume the final forward instead of dropping the frame.
      try {
        this.pendingFinalFlush = false;
        this.updateState((state) => { state.pendingFinalFlush = false; });
      } catch {}
      this.updateState((state) => {
        state.sessionIdle = true;
      });
    } finally {
      this.sending = false;
    }
  }
  /** Hidden tools — skip both tool_use and tool_result */
  static HIDDEN_TOOLS = HIDDEN_TOOLS;
  /** Check if a tool name is recall_memory */
  static isRecallMemory = isRecallMemory;
  /** Check if a file path points to a memory file */
  static isMemoryFile = isMemoryFile;
  /** Check if a tool should be hidden */
  static isHidden = (name) => {
    // Read through OutputForwarder.HIDDEN_TOOLS so runtime reassignment of
    // the static Set propagates into hidden-tool detection (restores the
    // original indirect-reference semantics before the tool-format split).
    // The non-set checks are inlined rather than delegated to the imported
    // isHidden, because that helper would re-consult the module-local
    // HIDDEN_TOOLS Set and ignore the OutputForwarder static.
    if (OutputForwarder.HIDDEN_TOOLS.has(name)) return true;
    if ((name.includes("plugin_mixdog") && !name.endsWith("recall_memory")) || name === "reply" || name === "react" || name === "edit_message" || name === "fetch" || name === "download_attachment") return true;
    return false;
  };
  /** Concatenate text blocks from a transcript entry (user or assistant). */
  static collectEntryText(entry) {
    const parts = entry?.message?.content;
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  /**
   * Remove mixdog worker/dispatch `<channel>` blocks whose `client_host_pid`
   * does not match this owner's MIXDOG_OWNER_HOST_PID. Own-worker and legacy
   * blocks (no client_host_pid) are left intact.
   */
  static stripForeignWorkerChannels(text) {
    if (!text || !/<channel\b/i.test(text)) return text || "";
    const owner = Number(process.env.MIXDOG_OWNER_HOST_PID);
    const ownerOk = Number.isFinite(owner) && owner > 0;
    return text.replace(/<channel\b([^>]*)>[\s\S]*?<\/channel>/gi, (block, openAttrs) => {
      if (!/\bsource\s*=\s*["'][^"']*mixdog/i.test(openAttrs)) return block;
      const m = openAttrs.match(/\bclient_host_pid\s*=\s*["']([^"']+)["']/i);
      if (!m) return block;
      if (!ownerOk) return block;
      const origin = Number(m[1]);
      if (!Number.isFinite(origin) || origin <= 0) return block;
      if (origin === owner) return block;
      return "";
    });
  }
  /**
   * Build a per-call dedup key for tool-log queue items.
   * Uses the full (unsquished) tool args so that two Reads on distinct files
   * sharing a basename, or two Grep/Glob calls sharing only a pattern prefix,
   * do not collapse onto the same key and suppress the second send.
   * Returns "" to fall back to md5(formatted) at delivery time.
   */
  static buildDedupKey = buildDedupKey;
  /** Build a tool log line from the tool name and input. */
  static buildToolLine = (name, input) => {
    // Pass OutputForwarder.isHidden as the hidden-tool predicate so reassign-
    // ment of the static propagates into tool-line construction (restores the
    // original indirect-reference semantics before the tool-format split).
    return buildToolLine(name, input, OutputForwarder.isHidden);
  };
  // ── File watch ─────────────────────────────────────────────────────
  /** Set callback for idle detection (no new data for 5s after assistant entry) */
  setOnIdle(cb) {
    this.onIdleCallback = cb;
  }
  /** Start watching transcript file for changes (runs once, never stops) */
  startWatch() {
    if (!this.transcriptPath) return;
    if (this.watchingPath === this.transcriptPath && this.watcher) {
      dropTrace("watch.start.skip", { reason: "already_watching", path: this.watchingPath });
      return;
    }
    this.closeWatcher();
    this.watchingPath = this.transcriptPath;
    dropTrace("watch.start.install", { path: this.watchingPath });
    try {
      this.watcher = watch(this.transcriptPath, () => this.scheduleWatchFlush());
      this.watcher.on("error", (err) => {
        dropTrace("watch.error", { path: this.watchingPath, err: String(err) });
        this.closeWatcher();
      });
      this.watcher.on("close", () => {
        dropTrace("watch.close.event", { path: this.watchingPath });
      });
      // Cover bytes written between the stat in setContext() and watch install.
      this.scheduleWatchFlush();
    } catch (e) {
      dropTrace("watch.start.catch", { path: this.watchingPath, err: String(e) });
      this.closeWatcher();
    }
  }
  /** Stop watching the transcript file. Delegates to closeWatcher() so
   *  callers that invoke stopWatch() on deactivation / ownership loss
   *  actually release the fs.watch handle + debounce/retry timers
   *  instead of leaking them for the lifetime of the process. */
  stopWatch() {
    this.closeWatcher();
  }
  /** Reset the idle timer — safety net in case turn-end signal is missed */
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.onIdleCallback) this.onIdleCallback();
    }, 1e3);
  }
  closeWatcher() {
    dropTrace("watch.close.call", { watcher: !!this.watcher, watchDebounce: !!this.watchDebounce, sendRetryTimer: !!this.sendRetryTimer, finalLen: this.finalLane.length, streamLen: this.streamLane.length, path: this.watchingPath || "(none)" });
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    if (this.sendRetryTimer) {
      clearTimeout(this.sendRetryTimer);
      this.sendRetryTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watchingPath = "";
  }
  scheduleWatchFlush() {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      let _wfStat = null;
      if (this.transcriptPath) {
        try { _wfStat = statSync(this.transcriptPath); } catch {}
      }
      if (this.transcriptPath && !_wfStat) {
        const relocated = detectCurrentSessionTranscript()?.transcriptPath ?? findLatestTranscriptByMtime();
        if (relocated && relocated !== this.transcriptPath) {
          process.stderr.write(`mixdog: watched transcript gone during flush, relocated to ${relocated}
`);
          dropTrace("watch.flush.relocate", { from: this.transcriptPath, to: relocated });
          this.closeWatcher();
          this.transcriptPath = relocated;
          this.mainSessionId = "";
          this.startWatch();
        }
        return;
      }
      this._pendingStat = _wfStat;
      this.forwardNewText().then((hadText) => {
        // Only trace when forwardNewText actually emitted text. hadText=false flushes
        // fire on every poll cycle and accumulate ~1MB/hour of identical no-op rows.
        if (hadText) dropTrace("watch.flush", { hadText, transcriptPath: this.transcriptPath || "(none)", watchingPath: this.watchingPath || "(none)" });
        if (hadText) {
          this.resetIdleTimer();
        }
      }).catch(err => process.stderr.write(`[output-forwarder] forwardNewText rejected: ${err?.message || err}\n`));
    }, 100);
  }
  updateState(mutator) {
    this.statusState.update(mutator);
  }
  // Debounced: every commitReadProgress() used to fire a full tmp+fsync+rename+
  // dir-fsync cycle through state-file.mjs writeJsonFile. Under steady
  // transcript progress (Discord forwarder following a live session) that
  // hit disk 5–10×/sec. Coalesce updates into a single write per 1.5s
  // window; final flush on process exit / explicit flushPersistState().
  persistState() {
    this._pendingPersistData = {
      lastFileSize: this.lastFileSize,
      sentCount: this.sentCount,
      lastSentHash: this.lastHash,
      lastSentTime: Date.now(),
      emoji: this.emoji,
      sessionIdle: false,
    };
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._flushPersistState();
    }, 1500);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }
  flushPersistState() { this._flushPersistState(); }
  _flushPersistState() {
    const data = this._pendingPersistData;
    if (!data) return;
    this._pendingPersistData = null;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this.updateState((state) => {
      state.lastFileSize = data.lastFileSize;
      state.sentCount = data.sentCount;
      state.lastSentHash = data.lastSentHash;
      state.lastSentTime = data.lastSentTime;
      state.emoji = data.emoji;
      state.sessionIdle = data.sessionIdle;
    });
  }
}
export {
  OutputForwarder,
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime
};
