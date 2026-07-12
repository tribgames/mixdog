/**
 * src/tui/engine/session-flow.mjs - prompt queue drain + session clear/reset. Extracted from engine.mjs.
 */
import { presentErrorText } from '../../runtime/shared/err-text.mjs';
import { resetAllStreamingMarkdownStablePrefixes } from '../markdown/streaming-markdown.mjs';
import { createSessionStats } from './session-stats.mjs';
import { queuePriorityValue, defaultQueuePriority, isQueuedEntryEditable, isQueuedEntryVisible, isSlashQueuedEntry, notificationDisplayText, sessionActivityTimestamp, promptDisplayText, mergePromptContents, mergePastedImages, mergePastedTexts, callCommitCallbacks, STEERING_SUPPRESSED_DISPLAY } from './queue-helpers.mjs';
import { appendTuiSteeringPersist, dropTuiSteeringPersist, drainTuiSteeringPersist } from './tui-steering-persist.mjs';

export function createSessionFlow(bag) {
  const {
    runtime, nextId, tuiDebug, flags, pending, pendingNotificationKeys, displayedExecutionNotificationKeys, clearExecutionDedupState, clearToastTimers, getState, set, pushItem, replaceItems, pushNotice, pushUserOrSyntheticItem, autoClearState, agentStatusState, routeState, syncContextStats, flushDeferredExecutionPendingResumeKick,
  } = bag;

  // Upper bound on the awaited compacting clear. requireCompactSuccess makes
  // runtime.clear() resolve only after compaction finishes; without a bound a
  // stalled compaction wedges autoClearRunning/commandBusy forever, which
  // suppresses the input drain. On timeout we abandon this attempt.
  // NOTE: this bounds how long the INPUT stays blocked (commandBusy), not the
  // compaction itself — the clear path's worst case (recall cold retries ~38s
  // + size-scaled semantic up to 120s) may exceed it, and that is fine: the
  // abandoned promise keeps running and the late-fulfillment path below
  // (autoClearInFlight / pendingClearedSessionUi) applies the clear when it
  // settles. Do NOT raise this to cover compaction worst cases.
  const AUTO_CLEAR_COMPACT_TIMEOUT_MS = 60_000;

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
    return {
      id: options.id || nextId(),
      text: displayText,
      content: text,
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
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
    // Claude Code parity: a queued prompt/notification can arrive while a
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
          // delivered to the model as plain text. Claude Code's queueProcessor
          // similarly handles slash entries outside the queued_command drain.
          predicate: (entry) => !isSlashQueuedEntry(entry),
        });
        firstBatch = false;
        if (batch.length === 0) break;
        tuiDebug(`busy-queue drain batch=${batch.length} remaining=${pending.length}`);
        const ids = new Set(batch.map((e) => e.id));
        const merged = mergePromptContents(batch);
        for (const entry of batch) {
          if (entry.mode === 'pending-resume') continue;
          // Live execution completions push their own immediate Response card
          // at delivery time; the queued twin is model-visible only and must
          // NOT render a second transcript card here (no fall-back to content).
          if (entry.suppressDisplay) continue;
          pushUserOrSyntheticItem(entry.text, entry.id, isQueuedEntryEditable(entry) ? 'user' : 'injected');
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
        const turnStatus = await bag.runTurn(merged, {
          displayText: batch.map((entry) => entry.text).filter((text) => String(text || '').trim()).join('\n'),
          pastedImages: batchPastedImages,
          pastedTexts: batchPastedTexts,
          onCommitted: () => commitSteeringQueueEntries(batch),
          submittedIds: [...ids],
          restorable: nonEditable.length === 0,
          requeueOnAbort,
          discardExecutionPendingResumeKeys,
        });
        if (flags.drainEpoch !== drainEpoch) return;
        // A deferred cleared-session UI sync (from a late-settling abandoned
        // compacting clear) applies here now that this turn has settled.
        flushDeferredClearedSessionUi();
        // session_manage tool: the model scheduled a reset during this turn.
        // Run it now, at the turn boundary — same clear body as auto-clear.
        // Cancelled/interrupted turns drop the reset (consume + discard): the
        // user aborted the turn that asked for it, so the destructive clear
        // must not fire. commandBusy guards against a concurrent session
        // command (resume/new) racing the async clear.
        const scheduledReset = runtime.consumePendingSessionReset?.();
        if ((scheduledReset === 'clear' || scheduledReset === 'compact_clear')
          && turnStatus !== 'cancelled'
          && !getState().commandBusy) {
          await performSessionClear({
            verb: scheduledReset === 'clear' ? 'Clearing conversation' : 'Compacting and clearing conversation',
            doneLabel: scheduledReset === 'clear' ? 'Session cleared' : 'Session compacted and cleared',
            skipLabel: 'Session reset skipped',
            surface: 'session-manage',
            useCompaction: scheduledReset === 'compact_clear',
          });
        }
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
    const entry = makeQueueEntry(text, options);
    if (entry.mode === 'task-notification' && entry.key) {
      if (pendingNotificationKeys.has(entry.key)) return false;
      pendingNotificationKeys.add(entry.key);
    }
    pending.push(entry);
    if (getState().busy && shouldMirrorSteeringEntry(entry)) {
      appendTuiSteeringPersist(leadSessionId(), entry);
    }
    if (isQueuedEntryVisible(entry)) set({ queued: [...getState().queued, entry] });
    if (getState().busy) tuiDebug(`busy-queue enqueue mode=${entry.mode} pending=${pending.length}`);
    void drain();
    return true;
  }

  function drainPendingSteering(_sessionIdOrOptions = null, maybeOptions = null) {
    const options = maybeOptions && typeof maybeOptions === 'object'
      ? maybeOptions
      : (_sessionIdOrOptions && typeof _sessionIdOrOptions === 'object' ? _sessionIdOrOptions : {});
    const maxPriority = options.maxPriority || 'next';
    // Claude Code parity: mid-chain drain converts queued prompt/task
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
        if (entry.suppressDisplay) {
          // Model-visible twin of an already-rendered live completion: deliver
          // content to the model but flag onSteerMessage to skip the duplicate
          // transcript card (no fall-back to content-derived display text).
          if (Array.isArray(content) ? content.length > 0 : String(content ?? '').trim().length > 0) {
            out.push({ text: STEERING_SUPPRESSED_DISPLAY, content });
          }
          continue;
        }
        const value = typeof content === 'string'
          ? content.trim()
          : { text: String(entry.text || '').trim(), content };
        if (typeof value === 'string') {
          if (value.length > 0) out.push(value);
        } else if (Array.isArray(value.content)) {
          if (value.content.length > 0) out.push(value);
        } else if (String(value.content ?? '').trim().length > 0) {
          out.push(value);
        }
      }
      commitSteeringQueueEntries(batch);
    }
    return out;
  }

  async function restoreLeadSteeringFromDisk() {
    const rows = await drainTuiSteeringPersist(leadSessionId());
    if (!rows.length) return;
    const restored = [];
    for (const row of rows) {
      const entry = makeQueueEntry(row.text, {
        steeringPersistRestored: true,
        steeringPersistId: row.steeringPersistId || undefined,
      });
      pending.push(entry);
      if (isQueuedEntryVisible(entry)) restored.push(entry);
    }
    if (restored.length > 0) set({ queued: [...getState().queued, ...restored] });
    void drain();
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
      const estimatedTokens = Math.max(0, Number(status?.currentEstimatedTokens ?? status?.usedTokens ?? 0));
      const usedTokens = Math.max(0, Number(status?.usedTokens ?? estimatedTokens ?? 0));
      const triggerTokens = Number(
        status?.compaction?.triggerTokens
        || status?.compaction?.autoCompactTokenLimit
        || runtime.session?.autoCompactTokenLimit
        || 0,
      );
      if (!(usedTokens > 0 && triggerTokens > 0)) {
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

  // Shared clear body for idle auto-clear and the session_manage tool.
  // useCompaction=true mirrors auto-clear (summarize via configured
  // compactType, context carries forward); false is a plain /clear wipe.
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
      let compactType = null;
      if (useCompaction) {
        const compaction = runtime.getCompactionSettings();
        compactType = compaction.compactType || compaction.type || null;
      }
      let clearResult;
      if (compactType) {
        // Bounded watchdog around the compacting clear. On timeout we throw so
        // the catch below keeps the conversation, surfaces a user-visible
        // notice, and the finally releases autoClearRunning/commandBusy so
        // input drains. The runtime clear cannot be cancelled, so we do NOT
        // walk away blind: an in-flight latch (autoClearInFlight) suppresses
        // new auto-clear attempts until the abandoned promise settles, and on
        // late fulfillment we run the same post-success UI sync as the normal
        // path so the UI cannot diverge from a runtime session that actually
        // got cleared. Late rejection or a false result is a no-op.
        const clearPromise = runtime.clear({ compactType, requireCompactSuccess: true });
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

  function restoreQueued(currentText = '') {
    const queued = [];
    for (let i = 0; i < pending.length;) {
      const entry = pending[i];
      if (isQueuedEntryEditable(entry)) {
        queued.push(entry);
        pending.splice(i, 1);
      } else {
        i += 1;
      }
    }
    removeQueuedEntries(queued);
    const queuedText = queued.map((item) => item.text).filter((text) => String(text || '').trim()).join('\n');
    const combinedText = [queuedText, String(currentText || '')].filter((text) => text.trim()).join('\n');
    return { count: queued.length, text: combinedText, pastedImages: mergePastedImages(queued), pastedTexts: mergePastedTexts(queued) };
  }

  const resetStats = () => {
    getState().stats = createSessionStats();
    return getState().stats;
  };
  const clearUiActivityBeforeContextSync = () => {
    clearToastTimers();
    resetAllStreamingMarkdownStablePrefixes();
    getState().items = replaceItems([]);
    getState().toasts = [];
    getState().queued = [];
    getState().thinking = null;
    getState().spinner = null;
    getState().lastTurn = null;
    getState().busy = false;
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
    getState().stats.currentContextTokens = 0;
    getState().stats.currentEstimatedContextTokens = 0;
    getState().stats.currentContextSource = null;
    getState().stats.currentContextUpdatedAt = Date.now();
    getState().displayContextWindow = 0;
    getState().compactBoundaryTokens = 0;
    getState().autoCompactTokenLimit = 0;
  };
  const snapshotTuiBeforeSessionReset = () => ({
    items: getState().items.slice(),
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
    getState().items = replaceItems(snapshot.items);
    getState().toasts = snapshot.toasts.slice();
    getState().queued = snapshot.queued.slice();
    getState().thinking = snapshot.thinking;
    getState().spinner = snapshot.spinner;
    getState().lastTurn = snapshot.lastTurn;
    getState().busy = snapshot.busy;
    getState().stats = { ...snapshot.stats };
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
  const resetStatsAndSyncContext = () => {
    resetStats();
    syncContextStats({ allowEstimated: true });
    return getState().stats;
  };

  return { leadSessionId, shouldMirrorSteeringEntry, commitSteeringQueueEntries, makeQueueEntry, removeQueuedEntries, requeueEntriesFront, dequeueQueueBatch, drain, enqueue, drainPendingSteering, restoreLeadSteeringFromDisk, autoClearBeforeSubmit, performSessionClear, restoreQueued, resetStats, clearUiActivityBeforeContextSync, resetTuiForPendingSessionReset, snapshotTuiBeforeSessionReset, restoreTuiAfterFailedSessionReset, resetStatsAndSyncContext };
}
