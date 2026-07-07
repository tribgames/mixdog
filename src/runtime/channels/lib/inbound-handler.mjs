import { recordFetchedMessages } from "./status-snapshot.mjs";
import {
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime,
  sameResolvedPath,
} from "./output-forwarder.mjs";
import { refreshActiveInstance } from "./runtime-paths.mjs";
import { isNetworkError, retryOnNetwork } from "./network-retry.mjs";
// Inbound message pipeline extracted from channels/index.mjs (behavior-
// preserving): serial inbound queue, backend.onMessage transcript (re)bind +
// steal logic, and handleInbound voice-transcription + parent notify. Bound to
// live runtime getters and shared primitives.
function isImageAttachment(contentType) {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("image/");
}
export function createInboundHandler({
  getBackend,
  getConfig,
  getBridgeRuntimeConnected,
  getChannelBridgeActive,
  instanceId,
  forwarder,
  scheduler,
  statusState,
  getBridgeOwnershipSnapshot,
  refreshBridgeOwnershipSafe,
  writeChannelOwner,
  shouldDropDuplicateInbound,
  resolveInboundRoute,
  isVoiceAttachment,
  transcribeVoice,
  getPersistedTranscriptPath,
  sessionIdFromTranscriptPath,
  pickUsableTranscriptPath,
  applyTranscriptBinding,
  rebindTranscriptContext,
  sendNotifyToParent,
  memoryAppendEntry,
  startServerTyping,
  stopServerTyping,
}) {
const inboundQueue = (() => {
  let tail = Promise.resolve();
  let _iqDepth = 0;
  const _IQ_MAX_DEPTH = 1000;
  return (fn) => {
    if (_iqDepth >= _IQ_MAX_DEPTH) {
      try { process.stderr.write(`mixdog: inboundQueue overflow (depth=${_iqDepth}), dropping message\n`); } catch {}
      return;
    }
    _iqDepth++;
    tail = Promise.resolve(tail).then(fn).catch((err) => {
      try { process.stderr.write(`mixdog: inboundQueue error: ${err && err.message || err}\n`); } catch {}
    }).finally(() => { _iqDepth--; });
  };
})();

getBackend().onMessage = (msg) => {
  const receivedAtMs = Number.isFinite(msg.receivedAtMs) ? msg.receivedAtMs : Date.now();
  const onMessageAtMs = Date.now();
  if (!getBridgeRuntimeConnected() || !getBridgeOwnershipSnapshot().owned) {
    refreshBridgeOwnershipSafe();
    return;
  }
  if (!getChannelBridgeActive()) return;
  if (shouldDropDuplicateInbound(msg)) return;
  // No label concept anymore: the channel id IS the identifier.
  recordFetchedMessages(msg.chatId, msg.chatId, [{ id: msg.messageId }], { markRead: true });
  if (!writeChannelOwner(msg.chatId)) return;
  const route = resolveInboundRoute(msg.chatId, msg.parentChatId);
  scheduler.noteActivity();
  startServerTyping(route.targetChatId);
  getBackend().resetSendCount();
  // Pin the prior turn's bound channel before this fire-and-forget flush so the
  // imminent rebind below (which mutates forwarder.channelId synchronously)
  // cannot redirect the previous turn's final output to the new channel.
  const priorForwardChannelId = forwarder.channelId || null;
  void forwarder.forwardFinalText(0, priorForwardChannelId).catch((err) => {
    try { process.stderr.write(`mixdog: forwardFinalText rejection: ${err?.stack || err}\n`); } catch {}
  }).finally(() => forwarder.reset());
  const previousPath = getPersistedTranscriptPath();
  let boundTranscript = null;
  let stoleSelfTranscript = false;
  let transcriptPath = forwarder.hasBinding() ? forwarder.transcriptPath : "";
  let needsStealPoll = false;
  // Reuse the current binding only while it still points at THIS owner's own
  // session. discoverSessionBoundTranscript() now ranks the live parent-chain
  // session (the one that forked this worker and receives injected input)
  // above a more-recently-touched neighbour, so when a co-located session
  // owns the stale binding we steal it back here instead of tailing the wrong
  // transcript for the rest of the process lifetime. Steal whenever the live
  // parent-chain (self) candidate resolves to a different path — even when its
  // transcript is not on disk yet: we keep selfBound.exists=false so the
  // downstream `!boundTranscript?.exists` branch routes through
  // rebindTranscriptContext()'s pending-bind + re-arm poll, which forwards the
  // first assistant reply once the self transcript is created. Marking the
  // stale neighbour path as exists=true here would suppress that rearm and
  // keep tailing the wrong session for the whole turn.
  if (transcriptPath) {
    const selfBound = discoverSessionBoundTranscript();
    const shouldStealBoundTranscript = Boolean(
      selfBound?.transcriptPath &&
      !sameResolvedPath(selfBound.transcriptPath, transcriptPath) &&
      selfBound.active === true &&
      (selfBound.parentChain === true || selfBound.cwdMatches === true)
    );
    if (shouldStealBoundTranscript) {
      process.stderr.write(`mixdog: inbound rebind: stealing transcript ${transcriptPath} -> ${selfBound.transcriptPath} (source=${selfBound.source || "unknown"}, exists=${selfBound.exists})\n`);
      transcriptPath = selfBound.transcriptPath;
      boundTranscript = selfBound;
      stoleSelfTranscript = true;
    } else {
      boundTranscript = {
        sessionId: sessionIdFromTranscriptPath(transcriptPath),
        sessionCwd: statusState.read().sessionCwd ?? null,
        transcriptPath,
        exists: true
      };
      // Fast path skips the poll below (zero added latency) unless we lack a
      // confident, currently-active self-bound candidate — that's the
      // ~ms race window right after activate, before the parent-chain
      // session record is published, where the steal gate above fails on
      // the very first inbound even though a real self session exists.
      if (!selfBound || selfBound.active !== true) needsStealPoll = true;
    }
  } else {
    boundTranscript = discoverSessionBoundTranscript();
    transcriptPath = pickUsableTranscriptPath(boundTranscript, previousPath);
    // Only fall back to latest-by-mtime when discovery did NOT produce a
    // confident, existing current-session transcript. detectCurrentSessionTranscript()
    // already weighs mtime (with a 30s decisive threshold) against active-pid /
    // cwd affinity, so overriding a real detected binding with the raw newest
    // file would clobber the current session with an unrelated, more-recently
    // touched transcript (wrong-session forward).
    if (!boundTranscript?.exists) {
      const latestByMtime = findLatestTranscriptByMtime(boundTranscript?.sessionCwd);
      if (latestByMtime && latestByMtime !== transcriptPath) {
        transcriptPath = latestByMtime;
      }
    }
  }
  // Binding-settled signal: resolves once the queued binding task below
  // (poll-if-needed + apply-bind + rebind) has run, so the react/status
  // IIFE can read the FINAL transcriptPath/boundTranscript instead of the
  // pre-poll snapshot. onMessage itself stays synchronous — nothing here
  // blocks message ordering or delays the enqueue calls.
  let bindingDoneResolve;
  const bindingDone = new Promise((resolve) => { bindingDoneResolve = resolve; });
  const queuedAtMs = Date.now();
  const preQueueMs = queuedAtMs - onMessageAtMs;
  const gatewayToQueueMs = queuedAtMs - receivedAtMs;
  if (preQueueMs > 250 || gatewayToQueueMs > 500) {
    process.stderr.write(`mixdog: inbound latency prequeue=${preQueueMs}ms gateway_to_queue=${gatewayToQueueMs}ms channel=${route.targetChatId}\n`);
  }
  // ONE queued task per message: binding (poll-if-needed + bind + rebind)
  // first, then handleInbound. Keeping both phases in a single task preserves
  // the queue's per-message depth accounting — the overflow guard drops a
  // whole message, never just its handleInbound half — and guarantees
  // bindingDone/stopServerTyping always settle even when the binding phase
  // throws. FIFO is preserved: inboundQueue chains tasks in call order, so
  // this message's poll delay (if any) defers only its own delivery.
  inboundQueue(async () => {
    try {
      if (needsStealPoll) {
        const POLL_INTERVAL_MS = 50;
        const POLL_TIMEOUT_MS = 500;
        const pollStart = Date.now();
        while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          // fresh: bypass the negative parent-pid cache inside the walk —
          // a transient parent-lookup miss cached just before this poll
          // would otherwise pin every retry to null until its TTL expires,
          // defeating the whole first-inbound recovery window.
          const retryBound = discoverSessionBoundTranscript({ fresh: true });
          const retryShouldSteal = Boolean(
            retryBound?.transcriptPath &&
            !sameResolvedPath(retryBound.transcriptPath, transcriptPath) &&
            retryBound.active === true &&
            (retryBound.parentChain === true || retryBound.cwdMatches === true)
          );
          if (retryShouldSteal) {
            process.stderr.write(`mixdog: inbound rebind (poll +${Date.now() - pollStart}ms): stealing transcript ${transcriptPath} -> ${retryBound.transcriptPath} (source=${retryBound.source || "unknown"}, exists=${retryBound.exists})\n`);
            transcriptPath = retryBound.transcriptPath;
            boundTranscript = retryBound;
            stoleSelfTranscript = true;
            break;
          }
        }
      }
      if (transcriptPath) {
        applyTranscriptBinding(route.targetChatId, transcriptPath, { cwd: boundTranscript?.sessionCwd });
      } else {
        refreshActiveInstance(instanceId, { channelId: route.targetChatId }, { onlyIfOwned: true });
      }
      if (!boundTranscript?.exists) {
        await rebindTranscriptContext(route.targetChatId, {
          // For a stolen self transcript (not yet on disk) the sync bind above
          // persisted lastFileSize=0 for this path, so catchUpFromPersisted makes
          // setContext resume from offset 0 once the file appears — forwarding
          // the first assistant reply. Relying on replayFromStart instead would
          // race: the discovery loop only sets replayFromStart when it first saw
          // the transcript as PENDING, so a file that already exists on the first
          // loop iteration would bind at EOF and skip the reply. Non-steal keeps
          // the original catch-up-from-cursor behaviour.
          previousPath: transcriptPath,
          catchUp: true,
          catchUpFromPersisted: stoleSelfTranscript ? true : undefined,
          persistStatus: true
        });
      }
    } catch (err) {
      try { process.stderr.write(`mixdog: inbound binding error: ${err}\n`); } catch {}
    } finally {
      bindingDoneResolve();
    }
    try {
      await handleInbound(msg, route, {
        sessionId: boundTranscript?.sessionId ?? sessionIdFromTranscriptPath(transcriptPath),
        receivedAtMs,
        queuedAtMs
      });
    } catch (err) {
      process.stderr.write(`mixdog: handleInbound error: ${err}\n`);
    } finally {
      stopServerTyping();
    }
  });
  void (async () => {
    try {
      await getBackend().react(msg.chatId, msg.messageId, "\u{1F914}");
    } catch {
    }
    await bindingDone;
    statusState.update((state) => {
      state.channelId = route.targetChatId;
      state.userMessageId = msg.messageId;
      state.emoji = "\u{1F914}";
      state.sentCount = 0;
      state.sessionIdle = false;
      if (transcriptPath) state.transcriptPath = transcriptPath;
      else delete state.transcriptPath;
      state.sessionCwd = boundTranscript?.sessionCwd ?? null;
    });
  })();
};
async function handleInbound(msg, route, options = {}) {
  const handleStartMs = Date.now();
  let text = msg.text;
  const voiceAtts = msg.attachments.filter((a) => isVoiceAttachment(a.contentType));
  if (voiceAtts.length > 0) {
    if (getConfig().voice?.enabled === false) {
      process.stderr.write(`mixdog: voice.transcription skipped — voice.enabled=false\n`);
      text = text || "[voice message]";
    } else {
      try {
        const files = await retryOnNetwork(
          // Short per-attempt timeout (vs the 180s default) bounds worst-case
          // blockage of the serial inboundQueue on a bad voice message.
          () => getBackend().downloadAttachment(msg.chatId, msg.messageId, { timeoutMs: 20_000 }),
          { label: "voice.download" }
        );
        // concurrency handled inside transcribeVoice queue; loop is sequential so last att wins
        for (const f of voiceAtts.map(a => files.find(df => df.id === a.id) ?? null).filter(Boolean)) {
          const _t0 = Date.now();
          const transcript = await retryOnNetwork(
            () => transcribeVoice(f.path, { attachmentId: f.id }),
            { label: "voice.transcription" }
          );
          const _elapsed = Date.now() - _t0;
          if (transcript) {
            text = transcript;
            process.stderr.write(`mixdog: voice.transcription ok (${f.name}, ${_elapsed}ms): ${transcript.slice(0, 50)}\n`);
          } else {
            process.stderr.write(`mixdog: voice.transcription empty (${f.name})\n`);
            text = text || "[voice message \u2014 transcription failed]";
          }
        }
      } catch (err) {
        const netFail = isNetworkError(err);
        process.stderr.write(`mixdog: voice.transcription error${netFail ? " (network, retries exhausted)" : ""}: ${err}\n`);
        const marker = netFail
          ? "[attachment: voice transcription failed (network)]"
          : `[voice message \u2014 transcription error: ${err?.message || err}]`;
        text = text ? `${text} ${marker}` : marker;
      }
    }
  }
  const hasVoiceAtt = voiceAtts.length > 0;
  // ── Inbound image attachments → downloaded local paths (vision) ──────
  // Mirror the voice path: download image/* attachments to the inbox and
  // hand their local paths downstream so the agent session can attach them
  // as real image content blocks. A short per-attempt timeout bounds the
  // serial inboundQueue against a slow/broken image; on failure we degrade
  // to the metadata-only marker (attMeta below) instead of dropping.
  const imageAtts = msg.attachments.filter((a) => isImageAttachment(a.contentType));
  let imagePaths = [];
  if (imageAtts.length > 0) {
    try {
      const files = (await retryOnNetwork(
        () => getBackend().downloadAttachment(msg.chatId, msg.messageId, {
          timeoutMs: 20_000,
          filter: (a) => isImageAttachment(a.contentType),
        }),
        { label: "image.download" }
      )) || [];
      imagePaths = imageAtts
        .map((a) => files.find((df) => df.id === a.id) ?? null)
        .filter(Boolean)
        .map((f) => f.path)
        .filter((p) => typeof p === "string" && p.length > 0);
      if (imagePaths.length > 0) {
        process.stderr.write(`mixdog: inbound images downloaded (${imagePaths.length})\n`);
      }
    } catch (err) {
      const netFail = isNetworkError(err);
      process.stderr.write(`mixdog: image.download error${netFail ? " (network, retries exhausted)" : ""}: ${err}\n`);
      const marker = netFail
        ? "[attachment: image download failed (network)]"
        : "[attachment: image download failed]";
      text = text ? `${text} ${marker}` : marker;
    }
  }
  // An image-only message can arrive with empty text; channelNotificationModelContent
  // drops empty content (runtime-core), which would strip meta.image_paths and lose
  // the image. Give it a non-empty marker so the notification (and its images) flow.
  if (imagePaths.length > 0 && !String(text || "").trim()) {
    text = "[image]";
  }
  const attMeta = msg.attachments.length > 0 && !hasVoiceAtt ? {
    attachment_count: String(msg.attachments.length),
    attachments: msg.attachments.map((a) => `${a.name} (${a.contentType}, ${(a.size / 1024).toFixed(0)}KB)`).join("; ")
  } : {};
  const messageBody = route.sourceMode === "monitor" && route.sourceLabel ? `[monitor:${route.sourceLabel}] ${text}` : text;
  const notificationMeta = {
    chat_id: route.targetChatId,
    message_id: msg.messageId,
    user: msg.user,
    user_id: msg.userId,
    ts: msg.ts,
    ...route.sourceMode === "monitor" ? {
      source_chat_id: route.sourceChatId,
      source_mode: route.sourceMode,
      ...route.sourceLabel ? { source_label: route.sourceLabel } : {}
    } : {},
    ...attMeta,
    ...msg.imagePath ? { image_path: msg.imagePath } : {},
    ...imagePaths.length > 0 ? { image_paths: JSON.stringify(imagePaths) } : {}
  };
  const notificationContent = messageBody;
  sendNotifyToParent("notifications/claude/channel", {
    content: notificationContent,
    meta: notificationMeta
  });
  const notifiedAtMs = Date.now();
  const receivedAtMs = Number.isFinite(options.receivedAtMs) ? options.receivedAtMs : handleStartMs;
  const queuedAtMs = Number.isFinite(options.queuedAtMs) ? options.queuedAtMs : handleStartMs;
  const queueMs = handleStartMs - queuedAtMs;
  const handleMs = notifiedAtMs - handleStartMs;
  const totalMs = notifiedAtMs - receivedAtMs;
  if (queueMs > 250 || handleMs > 250 || totalMs > 500) {
    process.stderr.write(`mixdog: inbound latency delivered total=${totalMs}ms queue=${queueMs}ms handle=${handleMs}ms channel=${route.targetChatId} attachments=${msg.attachments.length}\n`);
  }
  void memoryAppendEntry({
    ts: msg.ts,
    role: "user",
    content: messageBody,
    sourceRef: `discord:${route.targetChatId}#${msg.messageId}`,
    sessionId: `discord:${route.targetChatId}`,
    cwd: statusState.read().sessionCwd,
  });
}
}
