/**
 * src/tui/session/session-flow.mjs - prompt queue drain + session clear/reset. Extracted from session-local.mjs.
 */
import { presentErrorText } from '../../runtime/shared/err-text.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from '../markdown/streaming-markdown.mjs';
import { createSessionStats } from './session-stats.mjs';
  import { queuePriorityValue, defaultQueuePriority, isQueuedEntryEditable, isQueuedEntryVisible, isSlashQueuedEntry, notificationDisplayText, sessionActivityTimestamp, promptDisplayText, promptContentImageMeta, mergePromptContents, mergePastedImages, mergePastedTexts, callCommitCallbacks, STEERING_SUPPRESSED_DISPLAY } from './queue-helpers.mjs';
import { appendTuiSteeringPersist, dropTuiSteeringPersist, drainTuiSteeringPersist } from './tui-steering-persist.mjs';
import { parseModelVisibleCompletionWrapper } from './agent-envelope.mjs';
import { hydratePastedAttachments } from '../../runtime/attachments/store.mjs';

export function createSessionFlow(bag) {
  const {
    runtime, nextId, tuiDebug, flags, pending, pendingNotificationKeys, displayedExecutionNotificationKeys, clearExecutionDedupState, clearToastTimers, getState, set, flushEmitImmediate, pushItem, replaceItems, pushNotice, pushUserOrSyntheticItem, autoClearState, agentStatusState, routeState, syncContextStats, flushDeferredExecutionPendingResumeKick,
    snapshotTranscriptSpill, restoreTranscriptSpill, releaseTranscriptSpill,
  } = bag;

  // Upper bound on the awaited compacting clear. requireCompactSuccess makes
  // runtime.clear() resolve only after compaction finishes; without a bound a
  // stalled compaction wedges autoClearRunning/commandBusy forever, which
  // suppresses the input drain. On timeout we abandon this attempt.
  // NOTE: this bounds how long the INPUT stays blocked (commandBusy), not the
  // compaction itself — the clear path's worst case (Memory cold retries plus
  // a size-scaled handoff summary call) may exceed it, and that is fine: the
  // abandoned promise keeps running and the late-fulfillment path below
  // (autoClearInFlight / pendingClearedSessionUi) applies the clear when it
  // settles. Do NOT raise this to cover compaction worst cases.
  const AUTO_CLEAR_COMPACT_TIMEOUT_MS = 60_000;

  // Submission-id memory for idempotent re-delivery. A prompt can legitimately
  // reach this queue TWICE when its transport retries across a failed response
  // (daemon view retry, live-share spool fallback after a missing ack). The id
  // the surface minted is the identity of the message, so a repeat of an id we
  // already queued is dropped instead of posting the prompt twice.
  const SUBMISSION_ID_MEMORY = 256;
  const acceptedSubmissionIds = new Set();

  function rememberSubmissionId(id) {
    if (!id) return;
    acceptedSubmissionIds.add(id);
    while (acceptedSubmissionIds.size > SUBMISSION_ID_MEMORY) {
      const oldest = acceptedSubmissionIds.values().next().value;
      acceptedSubmissionIds.delete(oldest);
    }
  }

    const leadSessionId = () => runtime.id;

  function shouldMirrorSteeringEntry(entry) {
    return isQueuedEntryEditable(entry) && !isSlashQueuedEntry(entry);
  }

  function commitSteeringQueueEntries(entries) {
    callCommitCallbacks(entries);
    const mirrored = (Array.isArray(entries) ? entries : []).filter(
      (entry) => shouldMirrorSteeringEntry(entry) && !entry.steeringPersistRestored,
    );
    if (mirrored.length > 0) dropTuiSteeringPersist(leadSessionId(), mirrored);
  }

  function makeQueueEntry(text, options = {}) {
    const mode = options.mode || 'prompt';
    const priority = options.priority || defaultQueuePriority(mode);
    const displayText = promptDisplayText(text, options);
    const submittedAt = Number(options.submittedAt);
    return {
      id: options.id || nextId(),
      submittedAt: Number.isFinite(submittedAt) && submittedAt > 0
        ? Math.round(submittedAt)
        : Date.now(),
      text: displayText,
      content: text,
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
      images: promptContentImageMeta(text, options.pastedImages),
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
      onSettled: typeof options.onSettled === 'function' ? options.onSettled : null,
      onToolResult: typeof options.onToolResult === 'function' ? options.onToolResult : null,
      transcriptMeta: options.transcriptMeta && typeof options.transcriptMeta === 'object'
        ? { ...options.transcriptMeta }
        : null,
      context: options.context || null,
      mode,
      priority,
      key: options.key || null,
      skipSlashCommands: options.skipSlashCommands === true,
      displayText: mode === 'task-notification' ? notificationDisplayText(displayText) : String(displayText || ''),
      suppressDisplay: options.suppressDisplay === true,
      // Completion resumes are consumed exactly once: Esc abandons their
      // uncommitted body instead of putting it back at the queue front.
      abortDiscardOnAbort: options.abortDiscardOnAbort === true,
      resumeCompletionKeys: Array.isArray(options.resumeCompletionKeys)
        ? options.resumeCompletionKeys.filter((key) => key != null && String(key).trim())
        : [],
      steeringPersistId: options.steeringPersistId || null,
      steeringPersistRestored: options.steeringPersistRestored === true,
      isMeta: options.isMeta === true,
      goalId: options.goalId || null,
    };
  }

  function removeQueuedEntries(entries) {
    const ids = new Set(entries.map((entry) => entry.id));
    const queued = getState().queued.filter((q) => !ids.has(q.id));
    if (queued.length !== getState().queued.length) set({ queued });
  }

  function requeueEntriesFront(entries) {
    const restored = [];
    for (const entry of entries || []) {
      if (!entry || !String(entry.text || '').trim()) continue;
      const next = {
        ...entry,
        displayText: entry.displayText || (entry.mode === 'task-notification' ? notificationDisplayText(entry.text) : String(entry.text || '')),
      };
      if (next.mode === 'task-notification' && next.key) {
        const duplicateQueued = pending.some((entry) => entry?.mode === 'task-notification' && entry?.key === next.key);
        if (duplicateQueued) continue;
        if (!pendingNotificationKeys.has(next.key)) pendingNotificationKeys.add(next.key);
      }
      restored.push(next);
    }
    if (restored.length === 0) return false;
    pending.unshift(...restored);
    const visible = restored.filter(isQueuedEntryVisible);
    if (visible.length > 0) set({ queued: [...visible, ...getState().queued] });
    return true;
  }

  function dequeueQueueBatch(maxPriority = 'later', options = {}) {
    if (pending.length === 0) return [];
    const max = queuePriorityValue(maxPriority);
    const predicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    const limit = Math.max(1, Number(options.limit) || Infinity);
    let bestPriority = Infinity;
    let targetMode = null;
    for (const entry of pending) {
      if (!predicate(entry)) continue;
      const p = queuePriorityValue(entry.priority);
      if (p > max) continue;
      if (p < bestPriority) {
        bestPriority = p;
        targetMode = entry.mode || 'prompt';
      }
    }
    if (!targetMode) return [];
    const batch = [];
    for (let i = 0; i < pending.length;) {
      const entry = pending[i];
      if (predicate(entry) && (entry.mode || 'prompt') === targetMode && queuePriorityValue(entry.priority) === bestPriority) {
        batch.push(entry);
        pending.splice(i, 1);
        if (entry.mode === 'task-notification' && entry.key) pendingNotificationKeys.delete(entry.key);
        if (batch.length >= limit) break;
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(batch);
    return batch;
  }

  function scheduleBlockedDrainRetry() {
    if (pending.length === 0) return;
    if (flags.blockedDrainRetryTimer) return;
    const timer = setTimeout(() => {
      flags.blockedDrainRetryTimer = null;
      if (pending.length > 0) void drain();
    }, 50);
    if (typeof timer.unref === 'function') timer.unref();
    flags.blockedDrainRetryTimer = timer;
  }

  function clearBlockedDrainRetry() {
    if (!flags.blockedDrainRetryTimer) return;
    clearTimeout(flags.blockedDrainRetryTimer);
    flags.blockedDrainRetryTimer = null;
  }

  function hasModelDrainablePending() {
    return pending.some((entry) => !isSlashQueuedEntry(entry));
  }

  async function drain() {
    if (flags.draining) return;
    // Bail while any session command holds commandBusy (auto-clear implies it,
    // but so do setModel/newSession/resume/etc). Running a turn concurrently
    // with a command that swaps or reroutes the live session is a race; the
    // commandBusy-release hook re-kicks drain once the command finishes.
    if (flags.autoClearRunning || getState().commandBusy) {
      scheduleBlockedDrainRetry();
      return;
    }
    // A queued prompt/notification can arrive while a
    // provider turn is already in flight (scheduled message, webhook, agent
    // completion, or user input), but the unified queue only runs BETWEEN
    // turns. Do NOT start a second Lead runTurn from the post-turn drain in
    // that window: the active runtime.ask owns the session mutex/transcript.
    // Anything pending is kicked again by runTurn.finally once busy flips
    // false. Starting a parallel run here is what tangles turn order and can
    // abort/interleave the active turn.
    if (getState().busy) {
      tuiDebug(`busy-queue drain deferred while active pending=${pending.length}`);
      return;
    }
    clearBlockedDrainRetry();
    const drainEpoch = (Number(flags.drainEpoch) || 0) + 1;
    flags.drainEpoch = drainEpoch;
    flags.draining = true;
    let firstBatch = true;
    try {
      while (pending.length > 0) {
        if (flags.drainEpoch !== drainEpoch) return;
        // Drain one priority/mode bucket at a time (unified command queue):
        // unified command queue semantics: prompt steering stays editable and
        // task notifications stay non-editable but model-visible.
        const batch = dequeueQueueBatch('later', {
          limit: firstBatch ? 1 : Infinity,
          // Slash commands must run through the TUI command dispatcher, not be
          // delivered to the model as plain text, so slash entries are handled
          // outside the queued-command drain.
          predicate: (entry) => !isSlashQueuedEntry(entry),
        });
        firstBatch = false;
        if (batch.length === 0) break;
        if (batch[0]?.mode === 'goal-continuation'
          && bag.shouldRunGoalContinuation?.(batch[0]) !== true) {
          continue;
        }
        tuiDebug(`busy-queue drain batch=${batch.length} remaining=${pending.length}`);
        const ids = new Set(batch.map((e) => e.id));
        const merged = mergePromptContents(batch);
        for (const entry of batch) {
          // Async-completion twins (queued model-visible wrapper) used to be
          // display-skipped here on the assumption the live notification push
          // already rendered a card. That push is event-ephemeral and can be
          // missed (listener race, dedupe state from another surface, daemon
          // restart), which left completions with NO transcript card at all
          // (2026-08-17 field report: bench shell output never appeared).
          // Render the wrapper through the synthetic path instead — the
          // task_id upsert in upsertSyntheticToolItem patches an
          // already-rendered card, so the double-delivery case stays
          // duplicate-free. Non-wrapper entries keep the old skip.
          if (entry.mode === 'pending-resume' || entry.suppressDisplay) {
            const twin = typeof entry.content === 'string' ? entry.content : String(entry.text || '');
            if (parseModelVisibleCompletionWrapper(twin)) {
              pushUserOrSyntheticItem(twin, entry.id, 'injected');
            }
            continue;
          }
          const sender = String(entry.transcriptMeta?.sender || '').trim().toLowerCase();
          pushUserOrSyntheticItem(
            entry.text,
            entry.id,
            isQueuedEntryEditable(entry) ? 'user' : 'injected',
            Array.isArray(entry.images) && entry.images.length
              ? { images: entry.images, ...(sender ? { sender } : {}) }
              : sender ? { sender } : null,
          );
        }
        const nonEditable = batch.filter((entry) => !isQueuedEntryEditable(entry));
        // A completion resume is owned by the completion that woke it. Esc
        // consumes that ownership; unlike ordinary notifications it must never
        // be requeued from an uncommitted turn. Keep normal task notifications
        // recoverable exactly as before.
        const discardOnAbort = nonEditable.filter(
          (entry) => entry?.abortDiscardOnAbort === true || entry?.mode === 'pending-resume',
        );
        const requeueOnAbort = nonEditable.filter((entry) => !discardOnAbort.includes(entry));
        const discardExecutionPendingResumeKeys = discardOnAbort.flatMap(
          (entry) => Array.isArray(entry?.resumeCompletionKeys) ? entry.resumeCompletionKeys : [],
        );
        const batchPastedImages = mergePastedImages(batch);
        const batchPastedTexts = mergePastedTexts(batch);
        const batchSubmittedAt = batch.reduce((earliest, entry) => {
          const value = Number(entry.submittedAt);
          return Number.isFinite(value) && value > 0 ? Math.min(earliest, value) : earliest;
        }, Infinity);
        const turnStatus = await bag.runTurn(merged, {
          displayText: batch.map((entry) => entry.text).filter((text) => String(text || '').trim()).join('\n'),
          pastedImages: batchPastedImages,
          pastedTexts: batchPastedTexts,
          submittedAt: Number.isFinite(batchSubmittedAt) ? batchSubmittedAt : Date.now(),
          onCommitted: () => commitSteeringQueueEntries(batch),
          submittedIds: [...ids],
          restorable: nonEditable.length === 0,
          requeueOnAbort,
          discardExecutionPendingResumeKeys,
          transcriptMeta: batch[0]?.transcriptMeta || null,
          context: batch.map((entry) => String(entry.context || '').trim()).filter(Boolean).join('\n\n') || null,
          onToolResult: (message) => {
            for (const entry of batch) {
              try { entry.onToolResult?.(message); } catch {}
            }
          },
          onSettled: (detail) => {
            for (const entry of batch) {
              try { entry.onSettled?.(detail); } catch {}
            }
          },
        });
        if (flags.drainEpoch !== drainEpoch) return;
        // A deferred cleared-session UI sync (from a late-settling abandoned
        // compacting clear) applies here now that this turn has settled.
        flushDeferredClearedSessionUi();
        // If the user re-submits the reclaimed prompt while the cancelled turn
        // is still unwinding, enqueue() cannot start another drain because this
        // drain loop is still active. Continue when pending work appeared during
        // cancellation so the fresh submit does not get stuck in queued getState().
        if (turnStatus === 'cancelled' && pending.length === 0) break;
      }
    } finally {
      if (flags.drainEpoch === drainEpoch) {
        flags.draining = false;
        flushDeferredClearedSessionUi();
        if (hasModelDrainablePending()) void drain();
        else flushDeferredExecutionPendingResumeKick();
      }
    }
  }
  function enqueue(text, options = {}) {
    const submissionId = String(options.id || '').trim();
    // Idempotent intake: a transport that re-sent this exact submission (its
    // first attempt landed but the response was lost) must not double-post.
    if (submissionId && acceptedSubmissionIds.has(submissionId)) {
      tuiDebug(`prompt-duplicate id=${submissionId} ignored`);
      // This is an idempotent success, not a rejected submit. Returning false
      // makes Desktop restore and retry a message that is already queued.
      return true;
    }
    const entry = makeQueueEntry(text, options);
    if (entry.mode === 'task-notification' && entry.key) {
      if (pendingNotificationKeys.has(entry.key)) return false;
      pendingNotificationKeys.add(entry.key);
    }
    rememberSubmissionId(submissionId);
    pending.push(entry);
    const needsDurableSteering = (getState().busy || getState().commandBusy || flags.autoClearRunning)
      && shouldMirrorSteeringEntry(entry);
    const persistence = needsDurableSteering
      ? appendTuiSteeringPersist(leadSessionId(), entry)
      : null;
    if (isQueuedEntryVisible(entry)) {
      set({ queued: [...getState().queued, entry] });
      if (isQueuedEntryEditable(entry)) flushEmitImmediate?.();
    }
    const queueAgeMs = Math.max(0, Date.now() - Number(entry.submittedAt || Date.now()));
    tuiDebug(`prompt-queued id=${String(entry.id)} busy=${getState().busy ? 1 : 0} ageMs=${queueAgeMs}`);
    if (getState().busy) tuiDebug(`busy-queue enqueue mode=${entry.mode} pending=${pending.length}`);
    void drain();
    if (options.awaitPersistence === true && persistence) {
      return Promise.resolve(persistence).then((persisted) => {
        if (persisted !== false) return true;
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        removeQueuedEntries([entry]);
        if (submissionId) acceptedSubmissionIds.delete(submissionId);
        return false;
      });
    }
    return true;
  }

  function drainPendingSteering(_sessionIdOrOptions = null, maybeOptions = null) {
    const options = maybeOptions && typeof maybeOptions === 'object'
      ? maybeOptions
      : (_sessionIdOrOptions && typeof _sessionIdOrOptions === 'object' ? _sessionIdOrOptions : {});
    const maxPriority = options.maxPriority || 'next';
    // Mid-chain drain converts queued prompt/task
    // notification entries into model-visible "queued_command" style steering
    // only at provider continuation boundaries. Slash commands stay queued for
    // the post-turn command processor. `later` notifications (scheduled tasks)
    // are skipped unless the runtime explicitly asks for a later flush.
    const predicate = (entry) => {
      if (isSlashQueuedEntry(entry)) return false;
      const mode = entry?.mode || 'prompt';
      return mode === 'prompt' || mode === 'task-notification';
    };
    const out = [];
    for (;;) {
      const batch = dequeueQueueBatch(maxPriority, { predicate });
      if (batch.length === 0) break;
      for (const entry of batch) {
        const content = entry.content;
        const steeringMeta = {
          id: entry.id,
          submittedAt: entry.submittedAt,
          ...(Array.isArray(entry.images) && entry.images.length ? { images: entry.images } : {}),
          ...(entry.transcriptMeta && typeof entry.transcriptMeta === 'object'
            ? { transcriptMeta: entry.transcriptMeta }
            : {}),
        };
        if (entry.suppressDisplay) {
          // Model-visible twin of an already-rendered live completion: deliver
          // content to the model but flag onSteerMessage to skip the duplicate
          // transcript card (no fall-back to content-derived display text).
          if (Array.isArray(content) ? content.length > 0 : String(content ?? '').trim().length > 0) {
            out.push({ ...steeringMeta, text: STEERING_SUPPRESSED_DISPLAY, content });
          }
          continue;
        }
        const displayText = String(entry.text || '').trim();
        if (typeof content === 'string') {
          const value = content.trim();
          if (value.length > 0) out.push({ ...steeringMeta, text: displayText || value, content: value });
        } else if (Array.isArray(content)) {
          if (content.length > 0) out.push({ ...steeringMeta, text: displayText, content });
        } else if (String(content ?? '').trim().length > 0) {
          out.push({ ...steeringMeta, text: displayText, content });
        }
      }
      commitSteeringQueueEntries(batch);
    }
    return out;
  }

  async function restoreLeadSteeringFromDisk() {
    const rows = await drainTuiSteeringPersist(leadSessionId());
    if (!rows.length) return;
    const livePersistIds = new Set(
      pending.map((entry) => entry?.steeringPersistId).filter(Boolean),
    );
    // Crash-consumed dedup: a row whose text already landed in the session
    // transcript was consumed before the restart — only its disk drop was
    // lost (drop is an async fire-and-forget write). Re-queuing it silently
    // re-injects a stale prompt into the next turn (user report: surprise
    // self-injection after a process restart). A recent-window substring
    // match against user messages defines "already delivered"; substring
    // (not equality) because steering delivery may wrap the raw text.
    const recentUserTexts = [];
    {
      const messages = Array.isArray(runtime.session?.messages) ? runtime.session.messages : [];
      for (let i = messages.length - 1, seen = 0; i >= 0 && seen < 80; i -= 1) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        seen += 1;
        const text = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
            : '';
        if (text.trim()) recentUserTexts.push(text);
      }
    }
    const alreadyDelivered = (text) => recentUserTexts.some((body) => body.includes(text));
    const restored = [];
    let droppedDelivered = 0;
    for (const row of rows) {
      const text = String(row?.text || '').trim();
      if (!text) continue;
      // Live enqueue already holds this row (id assigned before the async
      // disk write). Replaying it is the classic double-booked queue.
      if (row.steeringPersistId && livePersistIds.has(row.steeringPersistId)) continue;
      if (alreadyDelivered(text)) {
        droppedDelivered += 1;
        continue;
      }
      const entry = makeQueueEntry(row.text, {
        id: row.submissionId || undefined,
        submittedAt: row.submittedAt || undefined,
        steeringPersistRestored: true,
        steeringPersistId: row.steeringPersistId || undefined,
      });
      pending.push(entry);
      if (row.submissionId) rememberSubmissionId(row.submissionId);
      if (entry.steeringPersistId) livePersistIds.add(entry.steeringPersistId);
      if (isQueuedEntryVisible(entry)) restored.push(entry);
    }
    if (restored.length > 0) set({ queued: [...getState().queued, ...restored] });
    if (droppedDelivered > 0) {
      try { process.stderr.write(`[tui] skipped ${droppedDelivered} already-delivered steering row(s) on restore\n`); } catch { /* best effort */ }
    }
    // Recovery must not create a user turn by itself. An idle reconnect leaves
    // the restored rows visible/editable in the queue; a real active-turn
    // boundary or later submit will invoke the normal drain path.
  }

  async function autoClearBeforeSubmit() {
    flushDeferredClearedSessionUi();
    const cfg = autoClearState();
    const now = Date.now();
    const activityAt = sessionActivityTimestamp(runtime.session, flags.lastUserActivityAt);
    const idleMs = activityAt ? now - activityAt : 0;
    if (!cfg.enabled || getState().busy || pending.length > 0 || flags.autoClearRunning || flags.autoClearInFlight || idleMs < cfg.idleMs) {
      if (!activityAt) flags.lastUserActivityAt = now;
      return false;
    }
    const minContextPercent = Number(cfg.minContextPercent ?? 10);
    if (minContextPercent > 0) {
      const status = runtime.contextStatus?.() || null;
      // A zero is often an unavailable/stale meter field, not an authoritative
      // measurement. Do not let it mask the sibling live estimate.
      const usedTokens = Math.max(
        0,
        Number(status?.usedTokens) || 0,
        Number(status?.currentEstimatedTokens) || 0,
        Number(status?.compaction?.currentEstimatedTokens) || 0,
      );
      const triggerTokens = Number(
        status?.compaction?.triggerTokens
        || status?.compaction?.autoCompactTokenLimit
        || runtime.session?.autoCompactTokenLimit
        || 0,
      );
      if (!Number.isFinite(usedTokens) || !Number.isFinite(triggerTokens)
        || !(usedTokens > 0 && triggerTokens > 0)) {
        if (!activityAt) flags.lastUserActivityAt = now;
        return false;
      }
      const usagePct = (usedTokens / triggerTokens) * 100;
      if (usagePct < minContextPercent) {
        if (!activityAt) flags.lastUserActivityAt = now;
        return false;
      }
    }
    return performSessionClear({
      verb: 'Auto-clearing idle conversation',
      doneLabel: 'Auto-clear complete',
      skipLabel: 'Auto-clear skipped',
      surface: 'auto-clear',
      useCompaction: true,
    });
  }

  // Shared session-clear body.
  // useCompaction=true mirrors auto-clear (fresh-context handoff carries
  // forward); false is a plain /clear wipe.
  async function performSessionClear({
    verb, doneLabel, skipLabel, surface, useCompaction,
    compactTimeoutMs = AUTO_CLEAR_COMPACT_TIMEOUT_MS,
  }) {
    flags.autoClearRunning = true;
    const startedAt = Date.now();
    // commandBusy blocks concurrent session commands (resume/newSession/
    // setModel) AND new submits for the duration of the async clear — the
    // clear swaps the live session object, so racing commands could act on
    // the wrong session.
    set({ commandBusy: true, commandStatus: { active: true, verb, startedAt, mode: 'auto-clear' } });
    try {
      // Give Ink one event-loop turn to paint the auto-clear status before the
      // clear/compact path starts doing synchronous session/transcript work.
      // Without this, long idle clears can look like a frozen prompt followed by
      // an already-complete status row.
      await new Promise((resolve) => setTimeout(resolve, 0));
      let clearResult;
      if (useCompaction) {
        // Bounded watchdog around the compacting clear. On timeout we throw so
        // the catch below keeps the conversation, surfaces a user-visible
        // notice, and the finally releases autoClearRunning/commandBusy so
        // input drains. The runtime clear cannot be cancelled, so we do NOT
        // walk away blind: an in-flight latch (autoClearInFlight) suppresses
        // new auto-clear attempts until the abandoned promise settles, and on
        // late fulfillment we run the same post-success UI sync as the normal
        // path so the UI cannot diverge from a runtime session that actually
        // got cleared. Late rejection or a false result is a no-op.
        const clearPromise = runtime.clear({ compact: true, requireCompactSuccess: true });
        let timer = null;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`compaction timed out after ${compactTimeoutMs}ms; auto-clear deferred to next idle`)),
            compactTimeoutMs,
          );
        });
        try {
          clearResult = await Promise.race([clearPromise, timeout]);
        } catch (raceError) {
          flags.autoClearInFlight = true;
          clearPromise.then(
            (lateResult) => {
              if (lateResult === false) return;
              if (getState().busy) {
                // A turn started after commandBusy released; applying the
                // cleared-session UI now would wipe items/queued and force
                // busy=false mid-turn. Defer until the current turn settles.
                flags.pendingClearedSessionUi = { doneLabel, surface };
              } else {
                applyClearedSessionUi(doneLabel);
                pushNotice(`${surface} completed late; session cleared`, 'info');
              }
            },
            () => {},
          ).finally(() => {
            // Keep suppressing new auto-clears until any deferred UI sync is
            // flushed at turn completion.
            if (!flags.pendingClearedSessionUi) flags.autoClearInFlight = false;
          });
          throw raceError;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } else {
        clearResult = await runtime.clear({});
      }
      if (clearResult === false) {
        throw new Error('runtime clear returned false');
      }
      applyClearedSessionUi(doneLabel);
      return true;
    } catch (error) {
      const message = presentErrorText(error, { surface });
      pushItem({
        kind: 'statusdone',
        id: nextId(),
        label: skipLabel,
        detail: `conversation kept · ${message}`,
      });
      pushNotice(`${surface} skipped: ${message}`, 'error');
      return false;
    } finally {
      flags.lastUserActivityAt = Date.now();
      flags.autoClearRunning = false;
      set({ commandBusy: false, commandStatus: null });
      void drain();
    }
  }

  function restoreQueued(currentText = '', selectedId = '') {
    const targetId = String(selectedId || '').trim();
    const queued = [];
    for (let i = 0; i < pending.length;) {
      const entry = pending[i];
      if (isQueuedEntryEditable(entry) && (!targetId || String(entry.id) === targetId)) {
        queued.push(entry);
        pending.splice(i, 1);
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(queued);
    const queuedText = queued.map((item) => item.text).filter((text) => String(text || '').trim()).join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    const hydrated = hydratePastedAttachments(mergePastedImages(queued), mergePastedTexts(queued));
    return {
      count: queued.length,
      ids: queued.map((item) => String(item.id || '')).filter(Boolean),
      text: combinedText,
      pastedImages: hydrated.pastedImages,
      pastedTexts: hydrated.pastedTexts,
    };
  }

  // `now` promotes one visible queued prompt ahead of its
  // siblings. The desktop follows this configure call with the normal abort
  // lane, so interruption keeps the existing recovery/requeue guarantees.
  function prioritizeQueued(selectedId = '') {
    const targetId = String(selectedId || '').trim();
    if (!targetId) return { count: 0, ids: [], priority: 'now' };
    const index = pending.findIndex((entry) =>
      isQueuedEntryEditable(entry)
      && !isSlashQueuedEntry(entry)
      && String(entry.id || '') === targetId);
    if (index < 0) return { count: 0, ids: [], priority: 'now' };
    const [entry] = pending.splice(index, 1);
    entry.priority = 'now';
    pending.unshift(entry);
    const visible = getState().queued.map((queuedEntry) =>
      String(queuedEntry?.id || '') === targetId
        ? { ...queuedEntry, priority: 'now' }
        : queuedEntry);
    set({ queued: visible });
    flushEmitImmediate?.();
    void drain();
    return { count: 1, ids: [targetId], priority: 'now' };
  }

  const resetStats = () => {
    const stats = createSessionStats();
    set({ stats });
    return stats;
  };
  const clearUiActivityBeforeContextSync = () => {
    clearToastTimers();
    resetAllStreamingMarkdownStablePrefixes();
    const items = replaceItems([]);
    set({
      items,
      toasts: [],
      queued: [],
      thinking: null,
      spinner: null,
      lastTurn: null,
      busy: false,
    });
    pendingNotificationKeys.clear();
    displayedExecutionNotificationKeys.clear();
    clearExecutionDedupState?.();
  };
  // Post-success UI sync shared by the normal clear path and a late-fulfilling
  // abandoned compacting clear, so the UI always matches the cleared runtime
  // session (no divergence / kept-items message loss).
  const applyClearedSessionUi = (doneLabel) => {
    resetStats();
    clearUiActivityBeforeContextSync();
    syncContextStats({ allowEstimated: true });
    set({
      items: replaceItems([]),
      toasts: [],
      queued: [],
      thinking: null,
      spinner: null,
      lastTurn: null,
      ...routeState(),
      stats: { ...getState().stats },
    });
    pushItem({ kind: 'statusdone', id: nextId(), label: doneLabel });
  };
  // Flush a deferred cleared-session UI sync once the active turn has settled.
  // Never forces busy=false mid-turn: bails while a turn is in flight.
  const flushDeferredClearedSessionUi = () => {
    if (!flags.pendingClearedSessionUi || getState().busy) return;
    const { doneLabel, surface } = flags.pendingClearedSessionUi;
    flags.pendingClearedSessionUi = null;
    flags.autoClearInFlight = false;
    applyClearedSessionUi(doneLabel);
    pushNotice(`${surface} completed late; session cleared`, 'info');
  };
  const resetTuiForPendingSessionReset = () => {
    flags.pendingSessionReset = true;
    clearUiActivityBeforeContextSync();
    resetStats();
    set({
      stats: {
        ...getState().stats,
        currentContextTokens: 0,
        currentEstimatedContextTokens: 0,
        currentContextSource: null,
        currentContextUpdatedAt: Date.now(),
      },
      displayContextWindow: 0,
      compactBoundaryTokens: 0,
      autoCompactTokenLimit: 0,
    });
  };
  const snapshotTuiBeforeSessionReset = () => ({
    items: getState().items.slice(),
    transcriptViewItems: Array.isArray(getState().transcriptViewItems)
      ? getState().transcriptViewItems.slice()
      : null,
    transcriptViewRevision: getState().transcriptViewRevision,
    transcriptSpill: snapshotTranscriptSpill?.() || null,
    toasts: getState().toasts.slice(),
    queued: getState().queued.slice(),
    thinking: getState().thinking,
    spinner: getState().spinner,
    lastTurn: getState().lastTurn,
    busy: getState().busy,
    stats: { ...getState().stats },
    sessionId: getState().sessionId,
  });
  const restoreTuiAfterFailedSessionReset = (snapshot) => {
    if (!snapshot) return;
    flags.pendingSessionReset = false;
    restoreTranscriptSpill?.(snapshot.transcriptSpill);
    const items = replaceItems(snapshot.items, { preserveSpill: true });
    set({
      items,
      transcriptViewItems: snapshot.transcriptViewItems,
      transcriptViewRevision: snapshot.transcriptViewRevision,
      toasts: snapshot.toasts.slice(),
      queued: snapshot.queued.slice(),
      thinking: snapshot.thinking,
      spinner: snapshot.spinner,
      lastTurn: snapshot.lastTurn,
      busy: snapshot.busy,
      stats: { ...snapshot.stats },
    });
    syncContextStats({ allowEstimated: true });
    set({
      items: getState().items,
      toasts: getState().toasts,
      queued: getState().queued,
      thinking: getState().thinking,
      spinner: getState().spinner,
      lastTurn: getState().lastTurn,
      busy: getState().busy,
      ...routeState(),
      stats: { ...getState().stats },
      ...agentStatusState(),
    });
  };
  const commitTuiSessionReset = (snapshot) => {
    releaseTranscriptSpill?.(snapshot?.transcriptSpill);
  };
  const resetStatsAndSyncContext = () => {
    resetStats();
    syncContextStats({ allowEstimated: true });
    return getState().stats;
  };

  return { leadSessionId, shouldMirrorSteeringEntry, commitSteeringQueueEntries, makeQueueEntry, removeQueuedEntries, requeueEntriesFront, dequeueQueueBatch, drain, enqueue, drainPendingSteering, restoreLeadSteeringFromDisk, autoClearBeforeSubmit, performSessionClear, restoreQueued, prioritizeQueued, resetStats, clearUiActivityBeforeContextSync, resetTuiForPendingSessionReset, snapshotTuiBeforeSessionReset, restoreTuiAfterFailedSessionReset, commitTuiSessionReset, resetStatsAndSyncContext };
}
