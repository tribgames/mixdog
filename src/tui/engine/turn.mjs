/**
 * src/tui/engine/turn.mjs - lead TUI turn engine (createRunTurn). Extracted from engine.mjs.
 */
import { aggregateToolCategoryEntry, aggregateDoneCategories, classifyToolCategory, formatAggregateDetail, summarizeToolResult } from '../../runtime/shared/tool-surface.mjs';
import { applyUsageDelta } from './session-stats.mjs';
import { pickVerb, pickDoneVerb, compactEventLabel, compactEventDetail } from './labels.mjs';
import { toolResultText, toolErrorDisplay } from './tool-result-text.mjs';
import { toolCallId, toolResultCallId, toolCallName, toolCallArgs } from './tool-call-fields.mjs';
import { promptDisplayText, STEERING_SUPPRESSED_DISPLAY } from './queue-helpers.mjs';
import { yieldToRenderer } from './render-timing.mjs';
import { aggregateRawResult, aggregateBucketForCategory, aggregateSummaries, assignAggregateSummaryOrder, failureDetailText, toolCallOutcome } from './tool-result-status.mjs';

export function createRunTurn(bag) {
  const {
    runtime, nextId, tuiDebug, LEAD_TURN_TIMEOUT_MS, flags, pending, itemIndexById, getState, set, pushItem, patchItem, replaceItems, updateStreamingTail: updateStreamingTailFromStore, settleStreamingTail: settleStreamingTailFromStore, clearStreamingTail: clearStreamingTailFromStore, pushNotice, pushUserOrSyntheticItem, markToolCallActive, markToolCallDone, clearActiveToolSummary, agentStatusState, routeState, syncContextStats, denyAllToolApprovals, requestToolApproval, patchToolCardResult, flushToolResults, flushDeferredExecutionPendingResumeKick, drain, drainPendingSteering,
  } = bag;
  // Small fallbacks keep isolated createRunTurn harnesses source-compatible;
  // the real engine supplies atomic implementations that also maintain revision.
  const updateStreamingTail = updateStreamingTailFromStore || ((id, patch = {}) => {
    set({ streamingTail: { ...(getState().streamingTail || {}), ...patch, kind: 'assistant', id, streaming: true } });
    return true;
  });
  const settleStreamingTail = settleStreamingTailFromStore || ((id, patch = {}) => {
    const tail = getState().streamingTail;
    if (!tail || tail.id !== id) return false;
    pushItem({ ...tail, ...patch, kind: 'assistant', id, streaming: false });
    set({ streamingTail: null });
    return true;
  });
  const clearStreamingTail = clearStreamingTailFromStore || ((id = null) => {
    if (id == null || getState().streamingTail?.id === id) set({ streamingTail: null });
    return true;
  });

    async function runTurn(userText, options = {}) {
    const turnIndex = getState().stats.turns || 0;
    const startedAt = Date.now();
    // Per-turn epoch. Force-release (watchdog grace) bumps the shared counter so
    // this turn's own eventual `finally` — which may run LONG after force-release
    // already started a new turn that reuses the per-session mutex — can detect
    // it is stale and skip all shared-getState() writes (busy, flags.activePromptRestore,
    // turndone, drain kick). Neutralizes the stale unwind without touching the mutex.
    const turnEpoch = ++flags.leadTurnEpoch;
    const isCurrentTurn = () => !flags.disposed && flags.leadTurnEpoch === turnEpoch;
    const inputBaseline = getState().stats.inputTokens;
    const outputBaseline = getState().stats.outputTokens;
    const submittedIds = Array.isArray(options.submittedIds) ? options.submittedIds : [];
    const displayText = promptDisplayText(userText, options);
    let promptCommittedCallbackCalled = false;
    flags.activePromptRestore = {
      text: String(displayText || '').trim(),
      pastedImages: options.pastedImages && typeof options.pastedImages === 'object' ? options.pastedImages : null,
      pastedTexts: options.pastedTexts && typeof options.pastedTexts === 'object' ? options.pastedTexts : null,
      onCommitted: typeof options.onCommitted === 'function' ? options.onCommitted : null,
      restorable: options.restorable !== false,
      submittedIds,
      reclaimed: false,
      committed: false,
      requeueEntries: Array.isArray(options.requeueOnAbort) ? options.requeueOnAbort.slice() : [],
      discardExecutionPendingResumeKeys: Array.isArray(options.discardExecutionPendingResumeKeys)
        ? options.discardExecutionPendingResumeKeys.slice()
        : [],
    };
    set({ busy: true, lastTurn: null, spinner: { active: true, verb: pickVerb(turnIndex), startedAt, responseLength: 0, inputTokens: 0, outputTokens: 0, mode: 'requesting' } });

    let assistantText = '';
    let currentAssistantId = null;

    tuiDebug(`runTurn start turn=${turnIndex} pending=${pending.length} timeoutMs=${LEAD_TURN_TIMEOUT_MS}`);
    // ── Idle watchdog ─────────────────────────────────────────────────────
    // If this turn stops making observable progress (provider call stuck),
    // trip after the cap: abort the in-flight run via the existing interrupt
    // path (runtime.abort, the same one Esc uses), which rejects the pending
    // runtime.ask() with a SessionClosedError so the normal cancelled-turn
    // teardown runs. Keep this progress-based rather than total wall-clock:
    // long multi-tool turns can legitimately exceed 5m while still producing
    // model/tool events.
    let watchdogTripped = false;
    let watchdogTimer = null;
    let watchdogGraceTimer = null;
    let lastProgressAt = startedAt;
    let lastProgressLabel = 'start';
    let watchdogDeferralCeilingAt = 0;
    const configuredLeadToolMaxMs = Number(process.env.MIXDOG_LEAD_TOOL_MAX_MS);
    const leadToolMaxMs = Number.isFinite(configuredLeadToolMaxMs) && configuredLeadToolMaxMs > 0
      ? configuredLeadToolMaxMs
      : 30 * 60 * 1000;
    const clearWatchdog = () => {
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      if (watchdogGraceTimer) { clearTimeout(watchdogGraceTimer); watchdogGraceTimer = null; }
    };
    const refreshWatchdogFromRuntimeLiveness = () => {
      let liveness;
      try { liveness = runtime.getTurnLiveness?.(); } catch { return false; }
      if (liveness?.stage !== 'tool_running') watchdogDeferralCeilingAt = 0;
      const progressAt = Number(liveness?.lastProgressAt);
      const now = Date.now();
      if (!liveness || !Number.isFinite(progressAt) || progressAt <= now - LEAD_TURN_TIMEOUT_MS) return false;

      if (liveness.stage === 'tool_running') {
        watchdogDeferralCeilingAt = 0;
        const toolStartedAt = Number(liveness.toolStartedAt);
        if (!Number.isFinite(toolStartedAt) || toolStartedAt <= 0) return false;
        const toolSelfDeadlineMs = Number(liveness.toolSelfDeadlineMs);
        const toolCeilingMs = Math.max(
          Number.isFinite(toolSelfDeadlineMs) && toolSelfDeadlineMs > 0 ? toolSelfDeadlineMs + 60_000 : 0,
          leadToolMaxMs,
        );
        if (now - toolStartedAt >= toolCeilingMs) return false;
        watchdogDeferralCeilingAt = toolStartedAt + toolCeilingMs;
      }

      lastProgressAt = progressAt;
      lastProgressLabel = `orchestrator:${String(liveness.stage || 'unknown')}`;
      armWatchdog();
      return true;
    };
    const armWatchdog = () => {
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      if (watchdogTripped) return;
      const now = Date.now();
      const remaining = Math.max(1, LEAD_TURN_TIMEOUT_MS - Math.max(0, now - lastProgressAt));
      const ceilingRemaining = watchdogDeferralCeilingAt > 0
        ? Math.max(1, watchdogDeferralCeilingAt - now)
        : Infinity;
      const delay = Math.min(remaining, ceilingRemaining);
      watchdogTimer = setTimeout(() => {
        if (!isCurrentTurn()) return;
        if (watchdogTripped) return;
        const now = Date.now();
        const idleMs = now - lastProgressAt;
        if (idleMs < LEAD_TURN_TIMEOUT_MS) {
          if (watchdogDeferralCeilingAt > 0 && now >= watchdogDeferralCeilingAt) {
            if (refreshWatchdogFromRuntimeLiveness()) return;
          } else {
            armWatchdog();
            return;
          }
        } else if (refreshWatchdogFromRuntimeLiveness()) return;
        watchdogTripped = true;
        if (_batchTimer !== null) {
          clearTimeout(_batchTimer);
          _batchTimer = null;
        }
        _pendingTextFlush = false;
        _pendingThinkFlush = false;
        _pendingThinkingLastEndedAt = 0;
        const elapsed = Date.now() - startedAt;
        tuiDebug(`runTurn WATCHDOG TRIP turn=${turnIndex} elapsedMs=${elapsed} idleMs=${idleMs} lastProgress=${lastProgressLabel} — aborting stuck turn`);
        pushNotice(`Turn timed out after ${Math.round(idleMs / 1000)}s idle (last progress: ${lastProgressLabel}) — aborting stuck request. Input will be released shortly if abort does not unwind.`, 'warn', { transcript: true });
        try { runtime.abort('cli-react-abort-watchdog'); } catch {}
        // Belt-and-suspenders: if runtime.abort() did not reject runtime.ask()
        // (unwind starved), hard-release the turn after a short grace so the
        // React store is never left with busy=true and no drain in flight.
        watchdogGraceTimer = setTimeout(() => {
          if (flags.disposed) return;
          if (!getState().busy) return;
          if (flags.leadTurnEpoch !== turnEpoch) return; // a newer turn already owns the store
          tuiDebug(`runTurn WATCHDOG FORCE-RELEASE turn=${turnIndex} — abort unwind starved`);
          denyAllToolApprovals('turn timed out');
          clearActiveToolSummary();
          flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true, cancelled: true });
          finalizeToolHeaders();
          clearDeferredTimers();
          flags.flushDeferredBeforeImmediatePush = null;
          if (currentAssistantId && currentAssistantText.trim()) {
            settleStreamingTail(currentAssistantId, { text: currentAssistantText });
          } else {
            clearStreamingTail(currentAssistantId);
          }
          // Bump the epoch FIRST so this (still-stuck) turn's later finally becomes
          // a no-op for shared getState() and cannot corrupt the turn we hand off to.
          flags.leadTurnEpoch++;
          set({ busy: false, spinner: null, thinking: null, lastTurn: null });
          flags.activePromptRestore = null;
          if (flags.draining) flags.draining = false;
          if (pending.length > 0) void drain();
          // busy→false here bypasses both the normal turn-end flush and the
          // drain-finally flush, so a deferred completion kick would never re-arm.
          // Fire it explicitly (idempotent: guarded by deferred flag + !busy).
          flushDeferredExecutionPendingResumeKick();
        }, 5_000);
        watchdogGraceTimer.unref?.();
      }, delay);
      watchdogTimer.unref?.();
    };
    const markTurnProgress = (label) => {
      if (!isCurrentTurn()) return false;
      if (watchdogTripped) return;
      lastProgressAt = Date.now();
      lastProgressLabel = String(label || 'progress');
      return true;
    };
    armWatchdog();
    let currentAssistantText = '';
    // Segments sealed as their own assistant item(s) this turn via
    // commitAssistantSegment (e.g. a tool preamble, then a no-newline tail
    // committed by onSteerMessage before an injected steering row). Kept as an
    // ordered list — NOT one concatenated string — so finalization can strip
    // each committed segment out of the provider's final content individually.
    // A single concatenation breaks when the provider omits an earlier segment
    // (e.g. a tool preamble) from result.content: the combined prefix no longer
    // matches and the tail would duplicate after the steering row.
    const committedSegments = [];
    let thinkingText = '';
    let thinkingStartedAt = 0;
    let thinkingSegmentStartedAt = 0;
    let accumulatedThinkingMs = 0;
    let cancelled = false;
    let askResult = null;
    let turnFinishedNormally = false;
    let transcriptCompactedThisTurn = false;
    const itemsAtTurnStart = getState().items.length;
    const submittedIdSet = new Set(submittedIds.filter((id) => id != null));
    const firstSubmittedIndex = getState().items.findIndex((item) => submittedIdSet.has(item?.id));
    // The submitted user row is pushed immediately before runTurn. Keep it and
    // everything produced after it if compaction succeeds mid-turn; dropping all
    // items would invalidate live tool-card ids and the streaming assistant tail.
    let currentTurnItemsStart = firstSubmittedIndex >= 0 ? firstSubmittedIndex : itemsAtTurnStart;
    const cardByCallId = new Map();
    const toolCards = [];
    const toolGroups = new Map();
    const resultsDone = new Set();
    // Streaming providers can deliver eager onToolResult before onToolCall registers
    // cards (send() still in flight). Hold those by callId until the batch lands.
    const earlyResultBuffer = new Map();
    const aggregateCards = []; // active aggregate cards in the current consecutive tool block
    let tailAggregate = null; // most recently touched aggregate card; only the tail may absorb the next same-bucket call
    let providerToolBatch = 0;

    // ── Deferred tool-card push (scroll/text sync) ────────────────────────────
    // A tool card used to enter the transcript the instant onToolCall fired,
    // reserving its estimated height (margin+header+detail) while ToolExecution
    // only painted blank placeholder rows for TOOL_PENDING_SHOW_DELAY_MS. With a
    // bottom-fixed viewport that shoved the body up BEFORE any glyph appeared, so
    // the scroll ran ahead of the text. We now hold each card off-screen for the
    // same delay and push it only when its real header/detail will paint (delay
    // elapsed) OR a result lands first (fast tool → completed card, no pending
    // flicker). Either way the pushed spec is stamped `deferredDisplayReady` so
    // ToolExecution renders the real header + 'Running' detail immediately
    // instead of the blank pre-delay placeholder — this matters for the
    // result-forced chain push (flushDeferredUpTo), where earlier-seq sibling
    // cards are pushed alongside the result-bearing one before their own delay
    // elapses and would otherwise paint an empty reserved band.
    // Mirrors components/ToolExecution.jsx TOOL_PENDING_SHOW_DELAY_MS.
    // Keep a fast call off-screen until it either resolves or has genuinely
    // been pending long enough to communicate work. This avoids a one-frame
    // Running→Finished flash while preserving the deferred entry's ordered,
    // result-forced materialization path.
    const TOOL_CARD_PUSH_DELAY_MS = 1000;
    let deferredSeqCounter = 0;
    const deferredEntries = []; // creation-order list; each is pushed at most once
    // Push this entry AND every earlier-created still-deferred entry, in order,
    // so transcript order always matches call order even when a later card's
    // result/timer fires before an earlier one's. Commit the collected cards in
    // ONE state update: emitting one pushItem() per deferred card made a tool
    // batch climb into view one row/card at a time (stepwise upward row jitter).
    const flushDeferredUpTo = (entry) => {
      if (!isCurrentTurn()) return;
      if (!entry) return;
      const specs = collectDeferredUpTo(entry);
      if (!specs.length) return;
      flags.pushingFromDeferredEntry = true;
      try { appendItemsBatch(specs); } finally { flags.pushingFromDeferredEntry = false; }
    };
    flags.flushDeferredBeforeImmediatePush = () => {
      if (!deferredEntries.length) return;
      const last = deferredEntries[deferredEntries.length - 1];
      if (last) flushDeferredUpTo(last);
    };
    const registerDeferredCard = (card) => {
      const entry = {
        seq: deferredSeqCounter++,
        pushed: false,
        timer: null,
        // Mark the card visible and return its spec WITHOUT emitting, so a
        // batched turn-close flush can commit many specs in one set().
        materialize: () => {
          card.pushed = true;
          if (!card.spec) return null;
          card.spec.deferredDisplayReady = true;
          return card.spec;
        },
        push: () => {
          const spec = entry.materialize();
          if (!spec) return;
          flags.pushingFromDeferredEntry = true;
          try { pushItem(spec); } finally { flags.pushingFromDeferredEntry = false; }
        },
      };
      card.deferred = entry;
      card.ensureVisible = () => flushDeferredUpTo(entry);
      deferredEntries.push(entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!isCurrentTurn()) return;
        flushDeferredUpTo(entry);
      }, TOOL_CARD_PUSH_DELAY_MS);
      entry.timer.unref?.();
    };
    const registerDeferredAggregate = (aggregate) => {
      const entry = {
        seq: deferredSeqCounter++,
        pushed: false,
        timer: null,
        materialize: () => {
          aggregate.pushed = true;
          if (!aggregate.pendingSpec) return null;
          aggregate.pendingSpec.deferredDisplayReady = true;
          return aggregate.pendingSpec;
        },
        push: () => {
          const spec = entry.materialize();
          if (!spec) return;
          flags.pushingFromDeferredEntry = true;
          try { pushItem(spec); } finally { flags.pushingFromDeferredEntry = false; }
        },
      };
      aggregate.deferred = entry;
      aggregate.ensureVisible = () => flushDeferredUpTo(entry);
      deferredEntries.push(entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!isCurrentTurn()) return;
        flushDeferredUpTo(entry);
      }, TOOL_CARD_PUSH_DELAY_MS);
      entry.timer.unref?.();
    };
    const clearDeferredTimers = () => {
      for (const e of deferredEntries) {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      }
    };
    // Collect (mark pushed + cancel timers) every still-deferred entry up to
    // `entry` in creation order, returning their specs WITHOUT emitting — the
    // caller commits them (optionally alongside a trailing turndone item) in a
    // single set() so turn-close writes land as ONE visible commit.
    const collectDeferredUpTo = (entry) => {
      const specs = [];
      if (!entry) return specs;
      for (const e of deferredEntries) {
        if (e.seq > entry.seq) break;
        if (e.pushed) continue;
        e.pushed = true;
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        const spec = e.materialize?.();
        if (spec) specs.push(spec);
      }
      return specs;
    };
    // Append pre-built items (deferred cards + turndone) in ONE set(). None are
    // 'user' kind, so no promptHistory rebuild is needed.
    const appendItemsBatch = (newItems, extra = {}) => {
      if (!isCurrentTurn()) return;
      if (!newItems || !newItems.length) { set(extra); return; }
      const base = getState().items.length;
      const items = [...getState().items, ...newItems];
      for (let i = 0; i < newItems.length; i++) {
        const it = newItems[i];
        if (it?.id != null) itemIndexById.set(it.id, base + i);
      }
      set({ items, structureRevision: (Number(getState().structureRevision) || 0) + 1, ...extra });
    };

    const markPromptCommitted = () => {
      if (flags.activePromptRestore) {
        if (!promptCommittedCallbackCalled && typeof flags.activePromptRestore.onCommitted === 'function') {
          promptCommittedCallbackCalled = true;
          try { flags.activePromptRestore.onCommitted(); } catch {}
        }
        flags.activePromptRestore.restorable = false;
        flags.activePromptRestore.committed = true;
        flags.activePromptRestore.requeueEntries = [];
        flags.activePromptRestore.pastedImages = null;
        flags.activePromptRestore.pastedTexts = null;
      }
    };

    const finalizeToolHeaders = () => {
      const ids = new Set();
      for (const card of toolCards || []) {
        if (card?.itemId) ids.add(card.itemId);
        // Seal not-yet-pushed specs too, so a card that pushes later (timer)
        // enters already-finalized instead of flashing the active header form.
        if (card && card.pushed === false && card.spec) card.spec.headerFinalized = true;
      }
      for (const aggregate of aggregateCards || []) {
        if (aggregate?.itemId) ids.add(aggregate.itemId);
        if (aggregate && aggregate.pushed === false && aggregate.pendingSpec) aggregate.pendingSpec.headerFinalized = true;
      }
      if (ids.size === 0) return false;
      let changed = false;
      const items = getState().items.map((item) => {
        if (!ids.has(item?.id) || item.kind !== 'tool' || item.headerFinalized !== false) return item;
        changed = true;
        return { ...item, headerFinalized: true };
      });
      if (changed) set({ items, structureRevision: (Number(getState().structureRevision) || 0) + 1 });
      return changed;
    };

    const completeAggregateVisual = () => {
      for (const aggregate of aggregateCards) {
        const allCalls = [...aggregate.calls.values()];
        if (allCalls.length === 0) continue;
        aggregate.ensureVisible?.();
        const errors = allCalls.filter((r) => r.isError).length;
        const callErrors = allCalls.filter((r) => r.isCallError).length;
        const exitErrors = allCalls.filter((r) => r.isExitError).length;
        const completed = allCalls.filter((r) => r.resolved).length;
        const succeeded = Math.max(0, completed - errors - exitErrors);
        const rawResult = aggregateRawResult(allCalls);
        // Merged count summary (see patchToolCardResult); real failures keep
        // 'N Failed', shell command-exits render 'Exit N'/'Y Exit'. Raw
        // preserved for ctrl+o expansion.
        const displayDetail = errors > 0 || exitErrors > 0
          ? failureDetailText({ succeeded, realErrors: callErrors, exitErrors, exitCode: allCalls.find((r) => r.isExitError)?.exitCode })
          : formatAggregateDetail(aggregateSummaries(aggregate));
        patchItem(aggregate.itemId, {
          result: displayDetail,
          text: displayDetail,
          rawResult: rawResult || null,
          isError: errors > 0,
          errorCount: errors,
          callErrorCount: callErrors,
          exitErrorCount: exitErrors,
          count: allCalls.length,
          completedCount: allCalls.length,
          doneCategories: aggregateDoneCategories(allCalls),
          completedAt: Date.now(),
        });
      }
    };

    const clearAggregateContinuation = () => {
      completeAggregateVisual();
      finalizeToolHeaders();
      aggregateCards.length = 0;
      // Seal the block: same-bucket calls after this point must open a fresh
      // card, never continue one from before the seal (assistant text/turn
      // end boundary).
      tailAggregate = null;
    };

    const rememberActiveAggregate = (aggregate) => {
      if (!aggregate) return;
      if (!aggregateCards.includes(aggregate)) aggregateCards.push(aggregate);
      tailAggregate = aggregate;
    };

    const ensureAggregateCard = (bucket) => {
      // Only the TAIL aggregate (most recent card) may absorb the next call,
      // and only when the bucket matches. Any different-bucket aggregate or
      // standalone card in between breaks the run, so Search, Memory, Search
      // renders as three cards in call order — a new call never merges into
      // an earlier card above the current tail (which read as out-of-order
      // count changes in the transcript). clearAggregateContinuation seals
      // the block at assistant-text/turn boundaries.
      const cached = tailAggregate && tailAggregate.bucket === bucket ? tailAggregate : null;
      if (cached) {
        rememberActiveAggregate(cached);
        return cached;
      }
      const itemId = nextId();
      const aggregate = {
        itemId,
        bucket,
        categories: new Map(),
        categoryOrder: [],
        calls: new Map(),
        nextSummarySeq: 0,
        pushed: false,
        startedAt: Date.now(),
      };
      // Arm the deferred push once at creation; syncAggregateHeader only keeps
      // pendingSpec current until the timer/result flushes it in call order.
      registerDeferredAggregate(aggregate);
      rememberActiveAggregate(aggregate);
      return aggregate;
    };

    const syncAggregateHeader = (aggregate) => {
      if (!aggregate?.itemId) return;
      const patch = {
        args: { categoryOrder: aggregate.categoryOrder.slice() },
        count: aggregate.calls.size,
        completedCount: [...aggregate.calls.values()].filter((r) => r.resolved || r.completedEarly).length,
        categories: Object.fromEntries(aggregate.categories),
      };
      if (aggregate.pushed) {
        patchItem(aggregate.itemId, patch);
        return;
      }
      // Not yet visible: keep the latest header spec current. The deferred entry
      // (armed at creation) pushes pendingSpec when its timer fires or a result
      // forces it visible, preserving call order via flushDeferredUpTo.
      aggregate.pendingSpec = {
        kind: 'tool',
        id: aggregate.itemId,
        name: '__aggregate__',
        ...patch,
        aggregate: true,
        result: null,
        rawResult: null,
        isError: false,
        expanded: false,
        headerFinalized: false,
        startedAt: aggregate.startedAt || Date.now(),
      };
    };

    const ensureAssistant = (initialText = '') => {
      if (!currentAssistantId) {
        currentAssistantId = nextId();
        // Do NOT reset currentAssistantText here. The first onTextDelta has
        // already accumulated the opening chunk before this batched flush runs;
        // wiping it dropped the leading characters and forced a later set() to
        // re-add them. Segment resets are owned by closeAssistantSegment().
        // Seed the new row with the already-visible text so the ● gutter and the
        // first body line appear in the SAME set()/emit() — no empty "●-only"
        // row that scrolls once on its own and again when the body lands.
        updateStreamingTail(currentAssistantId, { text: String(initialText || '') });
      }
      return currentAssistantId;
    };

    const closeAssistantSegment = () => {
      currentAssistantId = null;
      currentAssistantText = '';
      // Reset incremental-flush getState() so the next segment rescans from scratch.
      _streamScanLen = 0;
      _lastNewlineIdx = -1;
      _emittedNewlineIdx = -2;
      _emittedVisibleText = '';
    };

    const commitAssistantSegment = ({ sealToolBlock = false } = {}) => {
      const text = currentAssistantText || '';
      if (!text.trim()) {
        closeAssistantSegment();
        return false;
      }
      if (sealToolBlock) clearAggregateContinuation();
      const id = currentAssistantId || ensureAssistant(text);
      settleStreamingTail(id, { text });
      committedSegments.push(text);
      closeAssistantSegment();
      return true;
    };

    const startThinkingSegment = () => {
      const now = Date.now();
      if (!thinkingStartedAt) thinkingStartedAt = now;
      if (!thinkingSegmentStartedAt) thinkingSegmentStartedAt = now;
      return now;
    };

    const closeThinkingSegment = () => {
      if (!thinkingSegmentStartedAt) return;
      const now = Date.now();
      accumulatedThinkingMs += Math.max(0, now - thinkingSegmentStartedAt);
      thinkingSegmentStartedAt = 0;
      return now;
    };

    // --- Streaming-delta batcher ---
    // onTextDelta and onReasoningDelta fire on every tiny chunk (often <10 chars).
    // Each call previously called set() → emit() → full React reconcile. We
    // batch accumulated text and flush at most once per STREAM_BATCH_INTERVAL_MS
    // (≈16ms / 60fps cap). A forced flush happens before any tool call,
    // finalization, or error so those code paths see the correct text getState().
    // Flush cadence for streamed text/thinking. 8ms (~120fps) matches the Ink
    // render maxFps (index.jsx render({ maxFps: 120 })), so a queued batch is
    // never held back waiting for the next Ink frame. 16ms (~60fps) left every
    // other Ink frame idle, which made fast provider streams visibly land in
    // coarse chunks ("10 chars at a time").
    const STREAM_BATCH_INTERVAL_MS = 16;
    let _batchTimer = null;
    let _pendingTextFlush = false;   // true when a text/spinner update is queued
    let _pendingThinkFlush = false;  // true when a thinking update is queued
    let _pendingThinkingLastEndedAt = 0;
    let compactingActive = false;
    // Incremental streaming-flush getState(): avoids rescanning the full accumulated
    // assistant text (lastIndexOf) and re-finding the row index on every flush.
    let _streamScanLen = 0;        // chars of currentAssistantText already scanned for '\n'
    let _lastNewlineIdx = -1;      // offset of the last completed-line '\n' found so far
    let _emittedNewlineIdx = -2;   // newline offset backing _emittedVisibleText (-2 forces first compute)
    let _emittedVisibleText = '';  // cached visible slice for the current newline offset
    // Engine-local streaming scalars. Neither responseLength nor thinkingText is
    // rendered per-token by any consumer: App reads getState().thinking only as a
    // boolean (App.jsx `!!(getState().thinking || liveSpinner?.thinking)`) and the
    // Spinner takes outputTokens, not responseLength. So we keep these growing
    // values in engine-local vars and publish to the store only on a visible
    // transition (thinking on↔off), a completed visible text line, tool/usage
    // updates, or finalization — not on every 8ms streaming flush.
    let _publishedThinkingActive = false; // last thinking boolean pushed to store
    // responseLength is only consumed at finalize as an outputTokens fallback
    // (Math.round(responseLength/4)); we refresh getState().spinner.responseLength on
    // visible-line flush and finalize so that fallback stays valid.

    const flushStreamBatch = () => {
      if (_batchTimer !== null) {
        clearTimeout(_batchTimer);
        _batchTimer = null;
      }
      if (!isCurrentTurn()) {
        _pendingTextFlush = false;
        _pendingThinkFlush = false;
        _pendingThinkingLastEndedAt = 0;
        return;
      }
      if (_pendingTextFlush) {
        _pendingTextFlush = false;
        // Show only COMPLETED lines while streaming. The in-progress trailing
        // line stays hidden until its '\n' arrives, so the visible text never
  // grows a glyph at a time (no "Wh"→pause→"What happened…" partial reveal, no
        // CJK-width reflow jitter). The final non-streaming patch
        // (streaming:false) always carries the full text, so the tail line that
        // never got a newline still lands once at finalize.
        // Incrementally track the last completed-line '\n' offset instead of
        // rescanning the whole accumulated text every flush. Each char is
        // examined once across the stream (amortized O(n) total, not O(n) per
        // flush); when the newline offset hasn't advanced the visible text is
        // byte-identical to the last flush, so the slice below is skipped and
        // reused. Reveal semantics are unchanged: still only completed lines.
        const textLen = currentAssistantText.length;
        if (textLen < _streamScanLen) { _streamScanLen = 0; _lastNewlineIdx = -1; }
        for (let i = _streamScanLen; i < textLen; i++) {
          if (currentAssistantText.charCodeAt(i) === 10) _lastNewlineIdx = i;
        }
        _streamScanLen = textLen;
        let streamingVisibleText;
        if (_lastNewlineIdx === _emittedNewlineIdx) {
          streamingVisibleText = _emittedVisibleText;
        } else {
          streamingVisibleText = _lastNewlineIdx >= 0
            ? currentAssistantText.slice(0, _lastNewlineIdx + 1)
            : '';
          _emittedNewlineIdx = _lastNewlineIdx;
          _emittedVisibleText = streamingVisibleText;
        }
        const patch = {};
        // Do NOT create the assistant row (and scroll the transcript) before
        // there is a completed line with VISIBLE content to show. Until the
        // first '\n' the only pending getState() is the spinner; the row appears
        // together with its first visible line, so no empty "●-only" row
        // flashes/scrolls ahead of text. `.trim()` also guards the
        // whitespace-only case: a response that opens with leading newlines
        // ("\n\n# …") completes a blank line first, whose estimated height
        // still reserves rows and scrolls the transcript, but Markdown trims
        // the body to nothing — so the scroll advances onto an empty band for
        // a few seconds until a non-blank line lands. Don't create the row
        // until there is real content to paint.
        if (currentAssistantId || streamingVisibleText.trim()) {
          const id = ensureAssistant(streamingVisibleText);
          const current = getState().streamingTail;
          if (!current || current.id !== id || !Object.is(current.text, streamingVisibleText)) {
            patch.streamingTail = { kind: 'assistant', id, text: streamingVisibleText, streaming: true };
          }
        }
        // Only touch the spinner when there is a real reason: a visible-line
        // change (patch.items set above), a thinking→responding transition, or a
        // pending thinking end timestamp. Refresh responseLength here so the
        // finalize outputTokens fallback stays valid without a per-token push.
        const responseLengthVal = assistantText.length + thinkingText.length;
        const visibleLineChanged = patch.streamingTail !== undefined;
        const thinkingTransition = _publishedThinkingActive === true; // was thinking, now responding
        if (getState().spinner && (visibleLineChanged || thinkingTransition || _pendingThinkingLastEndedAt)) {
          patch.spinner = { ...getState().spinner, responseLength: responseLengthVal, thinking: false, thinkingLastEndedAt: _pendingThinkingLastEndedAt || getState().spinner.thinkingLastEndedAt, mode: compactingActive ? 'compacting' : 'responding' };
          _publishedThinkingActive = false;
        }
        if (Object.keys(patch).length > 0) set(patch);
        _pendingThinkingLastEndedAt = 0;
      }
      if (_pendingThinkFlush) {
        _pendingThinkFlush = false;
        // App only consumes getState().thinking as a boolean and the Spinner only
        // reads the thinking flag + timing anchors — none of them render the
        // growing thinkingText. So publish the thinking boolean only on the
        // OFF→ON transition (or when compacting toggles the flag), not on every
        // 8ms reasoning chunk. The full thinkingText stays engine-local and is
        // emitted at finalize via the normal spinner/thinking teardown.
        const nextThinkingActive = !compactingActive;
        // Skip the push when the published thinking boolean is unchanged: neither
        // the growing thinkingText nor responseLength is rendered per-token, and
        // the Spinner derives its live elapsed from the (already-published)
        // thinkingSegmentStartedAt anchor. Applies to both thinking and
        // compacting steady getState().
        if (nextThinkingActive === _publishedThinkingActive) {
          // no-op: boolean unchanged
        } else {
          const responseLengthVal = assistantText.length + thinkingText.length;
          const thinkingElapsedMs = accumulatedThinkingMs + (thinkingSegmentStartedAt ? Math.max(0, Date.now() - thinkingSegmentStartedAt) : 0);
          // getState().thinking stays a truthy sentinel while active; consumers read it
          // as a boolean. Keep the value stable (thinkingText) so a late consumer
          // still sees real text, but only push on transition.
          const patch = { thinking: compactingActive ? null : thinkingText };
          if (getState().spinner) {
            patch.spinner = compactingActive
              ? { ...getState().spinner, responseLength: responseLengthVal, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: getState().spinner.thinkingLastEndedAt || 0, mode: 'compacting' }
              : { ...getState().spinner, responseLength: responseLengthVal, thinking: true, thinkingStartedAt, thinkingSegmentStartedAt, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingElapsedMs, thinkingLastEndedAt: 0, mode: 'thinking' };
          }
          set(patch);
          _publishedThinkingActive = nextThinkingActive;
        }
      }
    };

    const scheduleStreamFlush = () => {
      if (_batchTimer !== null) return; // already scheduled; do not re-arm
      _batchTimer = setTimeout(flushStreamBatch, STREAM_BATCH_INTERVAL_MS);
      if (_batchTimer?.unref) _batchTimer.unref(); // don't prevent process exit
    };

    // __earlyNotify: show 1-line summary + completedCount immediately; defer
    // rawResult/expand and resultsDone to the history flush.
    const markToolCardCompletedState = (callId, message) => {
      const card = cardByCallId.get(callId);
      if (!card) return;
      // Early completion also clears the active-summary entry.
      markToolCallDone(card.callId);
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const callRec = aggregate.calls.get(callId);
        if (!callRec || callRec.resolved || callRec.completedEarly) return;
        aggregate.ensureVisible?.();
        const rawText = toolResultText(message?.content);
        // Tool result text (including HTTP/domain failures, zero matches, task
        // statuses, and shell output) is detail, not a failed invocation. Only
        // the provider's isError/error-tool envelope drives failure counts/red.
        const { exitCode, isExitError, isCallError } = toolCallOutcome(message, rawText);
        const isError = isCallError;
        const text = isError ? toolErrorDisplay(rawText, callRec.name || 'tool') : rawText;
        callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
        assignAggregateSummaryOrder(aggregate, callRec);
        callRec.isError = isError;
        callRec.isCallError = isCallError;
        callRec.isExitError = isExitError;
        callRec.exitCode = exitCode;
        callRec.resultText = text;
        callRec.completedEarly = true;
        const allCalls = [...aggregate.calls.values()];
        const completedCount = allCalls.filter((r) => r.resolved || r.completedEarly).length;
        const errors = allCalls.filter((r) => r.isError).length;
        const callErrors = allCalls.filter((r) => r.isCallError).length;
        const exitErrors = allCalls.filter((r) => r.isExitError).length;
        const succeeded = Math.max(0, completedCount - errors - exitErrors);
        const rawResult = aggregateRawResult(allCalls);
        // Collapsed detail carries the merged per-call count summary even on
        // the early-notify path; patching '' here flipped the detail row back
        // to the 'Running' placeholder between count updates (the visible
        // jitter). Failures keep 'N Failed'. Raw preserved for ctrl+o expansion.
        const displayDetail = errors > 0 || exitErrors > 0
          ? failureDetailText({ succeeded, realErrors: callErrors, exitErrors, exitCode: allCalls.find((r) => r.isExitError)?.exitCode })
          : formatAggregateDetail(aggregateSummaries(aggregate));
        const currentIndex = itemIndexById.get(card.itemId);
        const currentItem = Number.isInteger(currentIndex) && getState().items[currentIndex]?.id === card.itemId
          ? getState().items[currentIndex]
          : null;
        const visualCompleted = Math.max(
          completedCount,
          Math.min(allCalls.length, Number(currentItem?.completedCount || 0)),
        );
        const patch = {
          result: displayDetail,
          text: displayDetail,
          isError: errors > 0,
          errorCount: errors,
          callErrorCount: callErrors,
          exitErrorCount: exitErrors,
          count: allCalls.length,
          completedCount: visualCompleted,
        };
        if (visualCompleted >= allCalls.length) {
          patch.completedAt = Number(currentItem?.completedAt) || Date.now();
        }
        patchItem(card.itemId, patch);
        return;
      }
      // Non-aggregate eager tools are rare; flipping completedCount without
      // result changes pending/detail rendering and risks row jitter — wait for
      // the real history flush (unchanged behavior).
    };

    const deliverToolResultMessage = (message) => {
      if (message?.__earlyNotify === true) {
        const earlyCallId = toolResultCallId(message);
        if (earlyCallId) markToolCardCompletedState(earlyCallId, message);
        return;
      }
      flushToolResults([message], toolCards, cardByCallId, toolGroups, resultsDone);
    };

    try {
      const { result, session } = await runtime.ask(userText, {
        drainSteering: (_sessionId, drainOptions) => (isCurrentTurn() ? drainPendingSteering(drainOptions) : []),
        onStreamDelta: () => {
          markTurnProgress('stream-delta');
        },
        onSteerMessage: (text) => {
          if (!markTurnProgress('steer-message')) return;
          // A suppressed live-completion twin is model-visible only; its
          // Response card was already pushed at delivery time. Skip the
          // duplicate transcript item (progress is still marked above since
          // the content WAS injected into the model turn).
          if (text === STEERING_SUPPRESSED_DISPLAY) return;
          // Steering can be injected after a terminal no-tool response has
          // already streamed but before runTurn finalizes. Seal the current
          // assistant segment first so the steered user turn and the next
          // assistant response do not get visually merged into one bubble.
          flushStreamBatch();
          // Commit any pending assistant segment — including a streamed tail
          // that never got a trailing '\n' (no row/currentAssistantId created
          // yet). Using the shared segment-commit helper ensures that tail is
          // materialized as an assistant item instead of being dropped when a
          // steering/agent-completion injection races turn finalization.
          commitAssistantSegment({ sealToolBlock: true });
          assistantText = '';
          const value = String(text || '').trim();
          if (value) {
            // Any non-tool transcript item is a block boundary: seal the
            // aggregate continuation (not just finalize headers) so a later
            // same-category tool call opens a fresh card instead of reusing
            // one whose count would then change ABOVE this steered user item.
            clearAggregateContinuation();
            pushUserOrSyntheticItem(value, undefined, 'injected');
          }
        },
        onToolCall: async (_iter, calls) => {
          if (!markTurnProgress('tool-call')) return;
          markPromptCommitted();
          // Always flush any buffered mid-turn assistant text before the tool
          // card appears. Without this, when neither a thinking panel nor a
          // spinner is active the buffered text was dropped by the following
          // closeAssistantSegment(), so the message above the tool card vanished.
          flushStreamBatch();
          if (thinkingText && getState().thinking) {
            const thinkingLastEndedAt = closeThinkingSegment();
            set({ thinking: null, spinner: getState().spinner ? { ...getState().spinner, thinking: false, thinkingAccumulatedMs: accumulatedThinkingMs, thinkingLastEndedAt, mode: 'tool-use' } : getState().spinner });
            _publishedThinkingActive = false;
          } else if (getState().spinner) {
            set({ spinner: { ...getState().spinner, mode: 'tool-use' } });
          }
          const batchCalls = (calls || []).filter(Boolean);
          if (batchCalls.length === 0) return;
          const agentBatch = ++providerToolBatch;
          const committedAssistantSegment = commitAssistantSegment({ sealToolBlock: true });
          if (committedAssistantSegment) {
            // Let the pre-tool assistant preamble paint and settle before the
            // tool card reserves/pushes rows. The first frame emits the sealed
            // preamble; the second gives measured-height harvest a chance to
            // publish any Markdown/streaming→final correction. If the settle
            // frame is unnecessary, yieldToRenderer's fallback releases quickly.
            await yieldToRenderer({ frames: 2 });
            if (!isCurrentTurn()) return;
          }

          const touchedAggregates = new Set();
          // [jitter fix] Last standalone (Agent) card in this batch to reserve a
          // row for. Flushed AFTER the syncAggregateHeader loop so any earlier-seq
          // aggregate it would flush-through already has its pendingSpec built.
          let standaloneReserve = null;
          for (let i = 0; i < batchCalls.length; i++) {
            const c = batchCalls[i];
            const name = toolCallName(c);
            const args = toolCallArgs(c);
            // Category drives the aggregate bucket so only same-category calls
            // merge into one card; classify first, then bucket by it.
            const category = classifyToolCategory(name, args);
            // Agent actions aggregate only within this provider-emitted batch.
            // They stay outbound category cards; asynchronous inbound Responses
            // are separately tailed by the notification feed and never mix here.
            const bucket = aggregateBucketForCategory(category, { agentBatch });
            const callId = toolCallId(c);
            const callKey = callId || `__tool_${toolCards.length}_${i}`;
            // The old App scan counted multi-pattern calls via
            // aggregateToolCategoryEntry(...).count, not a flat 1. Derive the same
            // count here so the incremental Explore/Search summary matches.
            const activeCount = Number(aggregateToolCategoryEntry(name, args, category)?.count || 1);
            // Track Explore/Search calls as active for the incremental prompt-
            // line summary; cleared when their result lands or the turn ends.
            markToolCallActive(callKey, category, activeCount, Date.now());

            if (!bucket) {
              const itemId = nextId();
              // Defer the visible push: hold the spec and only enter the
              // transcript when the real header/detail will paint (delay
              // elapsed) or its result lands first. Avoids reserving blank
              // placeholder height that scrolls the body ahead of the glyphs.
              const card = {
                itemId,
                callId: callKey,
                done: false,
                pushed: false,
                spec: {
                  kind: 'tool',
                  id: itemId,
                  name,
                  args,
                  result: null,
                  isError: false,
                  expanded: false,
                  headerFinalized: false,
                  count: 1,
                  completedCount: 0,
                  startedAt: Date.now(),
                },
              };
              registerDeferredCard(card);
              if (callId) {
                cardByCallId.set(callId, card);
              }
              toolCards.push(card);
              // [jitter fix] Immediate row-reserve is deferred to after the
              // syncAggregateHeader loop below (see standaloneReserve): calling
              // ensureVisible() here would flushDeferredUpTo() every earlier-seq
              // entry — including an aggregate whose pendingSpec syncAggregateHeader
              // hasn't built yet — marking it pushed without inserting (lost/
              // out-of-order card). Record it and flush once headers exist.
              standaloneReserve = card;
              // A standalone card (Agent) breaks the consecutive run too: a
              // later same-bucket call must open a fresh card BELOW it, not
              // merge into an aggregate above it.
              tailAggregate = null;
              continue;
            }

            const categoryEntry = aggregateToolCategoryEntry(name, args, category);
            const aggregateCard = ensureAggregateCard(bucket);
            if (!aggregateCard.categories.has(categoryEntry.key)) aggregateCard.categoryOrder.push(categoryEntry.key);
            const prevCategory = aggregateCard.categories.get(categoryEntry.key);
            aggregateCard.categories.set(categoryEntry.key, {
              ...categoryEntry,
              count: Number(prevCategory?.count || 0) + Number(categoryEntry.count || 1),
            });
            aggregateCard.calls.set(callKey, { name, args, category, summary: null, summarySeq: null, isError: false, isCallError: false, isExitError: false, exitCode: null, resultText: null, resolved: false, completedEarly: false });
            touchedAggregates.add(aggregateCard);
            const card = { itemId: aggregateCard.itemId, callId: callKey, done: false, aggregate: aggregateCard };
            if (callId) {
              cardByCallId.set(callId, card);
            }
            toolCards.push(card);
          }

          for (const aggregateCard of touchedAggregates) {
            syncAggregateHeader(aggregateCard);
          }
          // [jitter fix] Now that every touched aggregate has its pendingSpec,
          // reserve the standalone (Agent) card's row immediately. Its
          // ensureVisible() flushes earlier-seq entries too, but those aggregates
          // are now push-ready so none is marked pushed without inserting.
          standaloneReserve?.ensureVisible?.();
          if (committedAssistantSegment) {
            // A pre-tool assistant preamble has already had one render frame to
            // settle. Do not let the first grouped tool card sit off-screen until
            // the normal 1s deferred timer: when it later inserts its real 3 rows,
            // the already-wrapped preamble visibly jumps. Surface the first card
            // now via the existing deferredDisplayReady path, so the post-
            // preamble frame contains the intended Running tool card immediately
            // (no blank placeholder, no delayed row insertion).
            const firstTouchedAggregate = [...touchedAggregates][0] || null;
            firstTouchedAggregate?.ensureVisible?.();
          }
          for (const [bufferedCallId, bufferedMessage] of earlyResultBuffer) {
            if (!cardByCallId.has(bufferedCallId)) continue;
            deliverToolResultMessage(bufferedMessage);
            earlyResultBuffer.delete(bufferedCallId);
          }
          await yieldToRenderer();
        },
        onToolResult: (message) => {
          if (!markTurnProgress('tool-result')) return;
          const callId = toolResultCallId(message);
          if (callId && !cardByCallId.has(callId) && !resultsDone.has(callId)) {
            earlyResultBuffer.set(callId, message);
            return;
          }
          deliverToolResultMessage(message);
        },
        onToolApproval: async (request) => {
          if (!markTurnProgress('tool-approval')) return { approved: false, reason: 'turn no longer active' };
          markPromptCommitted();
          flushStreamBatch();
          if (getState().spinner) set({ spinner: { ...getState().spinner, mode: 'tool-approval' } });
          const approval = await requestToolApproval(request);
          if (!isCurrentTurn()) return { approved: false, reason: 'turn no longer active' };
          return approval;
        },
        onCompactEvent: (event) => {
          if (!markTurnProgress('compact-event')) return;
          flushStreamBatch();
          // Non-tool transcript item — same block-boundary rule as the
          // steered user item above: seal any live aggregate first so a
          // later same-category tool call doesn't reuse a card whose count
          // would then change above this statusdone item.
          clearAggregateContinuation();
          const compactStatus = String(event?.status || '').toLowerCase();
          if (!['failed', 'skipped', 'no_change'].includes(compactStatus)) {
            const currentTurnItems = getState().items.slice(currentTurnItemsStart);
            set({ items: replaceItems(currentTurnItems, { preserveStreamingTail: true }) });
            currentTurnItemsStart = 0;
            transcriptCompactedThisTurn = true;
          }
          pushItem({
            kind: 'statusdone',
            id: nextId(),
            label: compactEventLabel(event),
            detail: compactEventDetail(event),
          });
          // Compaction itself remains owned by the pre-provider-send pass.
          // This event only refreshes the gauge from the already-mutated
          // transcript before another render can show stale pressure.
          syncContextStats({ allowEstimated: true });
        },
        onStageChange: async (stage, detail = null) => {
          if (!markTurnProgress(`stage:${String(stage || '')}`)) return;
          if (!getState().spinner) return;
          const value = String(stage || '');
          if (value === 'compacting') {
            compactingActive = true;
            const thinkingLastEndedAt = closeThinkingSegment();
            _pendingThinkFlush = false;
            _publishedThinkingActive = false; // compacting cleared the thinking flag
            set({
              thinking: null,
              spinner: {
                ...getState().spinner,
                thinking: false,
                thinkingSegmentStartedAt: 0,
                thinkingAccumulatedMs: accumulatedThinkingMs,
                thinkingLastEndedAt: thinkingLastEndedAt || getState().spinner.thinkingLastEndedAt || 0,
                mode: 'compacting',
              },
            });
            await yieldToRenderer();
            return;
          }
          if (value === 'reconnecting') {
            compactingActive = false;
            const retryVerb = String(detail?.message || 'Reconnecting');
            set({ spinner: { ...getState().spinner, mode: 'reconnecting', verb: retryVerb } });
            await yieldToRenderer();
            return;
          }
          if (value === 'requesting' || value === 'streaming') compactingActive = false;
          const mode = value === 'requesting'
            ? 'requesting'
            : value === 'streaming'
              ? (getState().spinner.thinking ? 'thinking' : 'responding')
              : null;
          if (!mode || getState().spinner.mode === mode) return;
          set({ spinner: { ...getState().spinner, mode } });
        },
        onTextDelta: (chunk) => {
          const textChunk = String(chunk ?? '');
          if (!textChunk) return;
          if (!markTurnProgress('text-delta')) return;
          markPromptCommitted();
          const thinkingLastEndedAt = closeThinkingSegment();
          // Drop any queued think-flush too: it would otherwise re-publish
          // spinner.thinking:true from flushStreamBatch and resurrect the
          // indicator after we cleared it here.
          _pendingThinkFlush = false;
          if (getState().thinking) { set({ thinking: null }); _publishedThinkingActive = false; } // collapse thinking panel immediately, no batch delay
          assistantText += textChunk;
          currentAssistantText += textChunk;
          // Accumulate text and schedule a batched flush (≤1 render per
          // STREAM_BATCH_INTERVAL_MS). Without scheduling, mid-turn text only
          // surfaced via the tool-call/finalize flush, so a text→tool segment
          // with no spinner/thinking dropped the message above the tool card.
          _pendingTextFlush = true;
          if (thinkingLastEndedAt) _pendingThinkingLastEndedAt = thinkingLastEndedAt;
          scheduleStreamFlush();
        },
        onAssistantText: (text) => {
          // Mid-turn assistant text that precedes a tool call. Providers that
          // stream via onTextDelta already accumulated it into assistantText;
          // providers that only return the final response.content (no deltas)
          // never fired onTextDelta, so without this the preamble shows nothing
          // before the tool card. De-dup against already-streamed text so the
          // streaming path is unaffected.
          const full = String(text ?? '');
          if (!full.trim()) return;
          if (!markTurnProgress('assistant-text')) return;
          // If the streaming path already produced text for THIS segment,
          // onTextDelta owns the render — content is the same accumulated text
          // (or a superset), so skip to avoid double-printing the preamble.
          // Do not check turn-global assistantText: earlier closed preambles stay
          // there across tool calls, and would suppress later non-streaming
          // preambles even though currentAssistantText has been reset.
          if (currentAssistantText.trim()) return;
          markPromptCommitted();
          closeThinkingSegment();
          _pendingThinkFlush = false; // see onTextDelta: prevent a stale think flush resurrecting the indicator
          if (getState().thinking) { set({ thinking: null }); _publishedThinkingActive = false; }
          assistantText += full;
          currentAssistantText += full;
          _pendingTextFlush = true;
          flushStreamBatch();
        },
        onReasoningDelta: (chunk) => {
          if (!isCurrentTurn() || watchdogTripped) return;
          if (String(chunk ?? '')) {
            if (!markTurnProgress('reasoning-delta')) return;
            markPromptCommitted();
          }
          startThinkingSegment();
          thinkingText += String(chunk ?? '');
          // Accumulate reasoning text; fire at most one render per STREAM_BATCH_INTERVAL_MS.
          _pendingThinkFlush = true;
          scheduleStreamFlush();
        },
        onUsageDelta: (delta) => {
          if (!markTurnProgress('usage-delta')) return;
          applyUsageDelta(getState().stats, delta);
          syncContextStats({ allowEstimated: true });
          const currentTurnInput = Math.max(0, getState().stats.inputTokens - inputBaseline);
          const currentTurnOutput = Math.max(0, getState().stats.outputTokens - outputBaseline);
          if (getState().spinner) {
            set({ stats: { ...getState().stats }, spinner: { ...getState().spinner, inputTokens: currentTurnInput, outputTokens: currentTurnOutput } });
          } else {
            set({ stats: { ...getState().stats } });
          }
        },
      });
      if (!isCurrentTurn()) {
        cancelled = true;
      } else {
        askResult = result;
        markPromptCommitted();
        if (result?.terminationReason === 'refusal') {
          pushNotice(
            'The model refused to respond (safety refusal) — retry or rephrase your prompt.',
            'warn',
            { transcript: true },
          );
        }

        flushToolResults(session?.messages || [], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true });
        finalizeToolHeaders();
        flushStreamBatch(); // force-flush any batched streaming text before finalization writes
        syncContextStats({ allowEstimated: true });

        const finalText = result?.content != null ? String(result.content) : '';
        // Strip text already sealed as its own item(s) this turn (a tool
        // preamble, then a no-newline tail committed by onSteerMessage before an
        // injected steering row) so finalization reconciles only the uncommitted
        // remainder — never re-creating a committed segment as a duplicate item
        // that also reorders after the steering row. Walk the segments IN ORDER,
        // peeling each off the front of the remaining content; skip leading
        // whitespace/newlines between segments. A segment that does not match at
        // the current position (provider omitted it from result.content, e.g. a
        // tool preamble) is left in place and the walk moves on.
        let finalRemainder = finalText;
        for (const seg of committedSegments) {
          // Compare against the whitespace-skipped remainder AND a
          // whitespace-trimmed segment: a segment sealed with its own leading
          // newline ('\nTAIL') would otherwise never match the skipped remainder
          // ('TAIL') and duplicate after the steering row.
          const skipped = finalRemainder.replace(/^\s+/, '');
          const trimmedSeg = seg ? seg.replace(/^\s+/, '') : '';
          if (trimmedSeg && skipped.startsWith(trimmedSeg)) {
            finalRemainder = skipped.slice(trimmedSeg.length);
          }
        }
        if (finalRemainder.trim()) {
          // The persisted transcript is written from the provider's final content,
          // while the live TUI row is fed by streaming deltas. If a provider/parser
          // misses or suppresses an early delta, keeping the streamed buffer here
          // leaves the final on-screen assistant row missing leading characters even
          // though the transcript is correct. Always reconcile the active segment to
          // the final provider text when it is available.
          const id = currentAssistantId || ensureAssistant(finalRemainder);
          currentAssistantText = finalRemainder;
          settleStreamingTail(id, { text: finalRemainder });
        } else if (currentAssistantId && (currentAssistantText.trim() || assistantText.trim())) {
          const streamedText = currentAssistantText || assistantText;
          settleStreamingTail(currentAssistantId, { text: streamedText });
        }
        turnFinishedNormally = true;
      }
    } catch (error) {
      const staleCatch = !isCurrentTurn();
      if (staleCatch) {
        cancelled = true;
      } else {
        flushStreamBatch(); // ensure any batched text lands before the error notice
        if (error?.name === 'SessionClosedError') {
          cancelled = true;
          if (assistantText.trim() && currentAssistantId) {
            settleStreamingTail(currentAssistantId, { text: currentAssistantText || assistantText });
          }
          // Finalize pending tool cards so they don't stay "Running..." forever
          // after cancellation. Without this, the spinner vanishes and TurnDone
          // shows "cancelled", but in-flight tool cards remain in a perpetual
          // pending/blinking getState() because the normal finalize path (line 992)
          // was skipped when the error interrupted the try block.
          flushToolResults([], toolCards, cardByCallId, toolGroups, resultsDone, { finalize: true, cancelled: true });
          finalizeToolHeaders();
        } else {
          finalizeToolHeaders();
          pushNotice(toolErrorDisplay(error, 'turn'), 'error');
        }
      }
    } finally {
      const isStaleUnwind = !isCurrentTurn();
      if (!isStaleUnwind) denyAllToolApprovals(cancelled ? 'turn cancelled' : 'turn finished');
      // Turn is unwinding normally (or via abort) — cancel the idle watchdog and
      // its force-release grace so they never fire on a live turn.
      clearWatchdog();
      // If the watchdog force-release already fired, a NEWER turn now owns the
      // shared store (busy, flags.activePromptRestore, turndone, drain). This stale
      // unwind must NOT write shared getState() or it corrupts that turn.
      let closingItems = [];
      if (deferredEntries.length) {
        if (!isStaleUnwind) {
          // Flush any still-deferred tool cards into the transcript and cancel
          // their pending push timers so nothing fires (or leaks) after the turn
          // ends. The finalize path above already patches results onto visible
          // cards; this just guarantees every registered card is materialized
          // before the turn closes. Collect (don't emit) the still-deferred cards
          // so the turn-close flush and the turndone item append in ONE set()
          // below instead of one render bounce per row. Order/ids are preserved
          // (creation order, then turndone last).
          const last = deferredEntries[deferredEntries.length - 1];
          closingItems = collectDeferredUpTo(last);
        }
        clearDeferredTimers();
      }
      if (!isStaleUnwind) flags.flushDeferredBeforeImmediatePush = null;
      closeThinkingSegment();
      if (isStaleUnwind) {
        tuiDebug(`runTurn STALE UNWIND turn=${turnIndex} — force-released; skipping shared UI/state writes`);
      } else {
        if (currentAssistantId && getState().streamingTail?.id === currentAssistantId) {
          if (currentAssistantText.trim()) {
            settleStreamingTail(currentAssistantId, { text: currentAssistantText });
          } else {
            clearStreamingTail(currentAssistantId);
          }
        }
        const producedTranscriptItem =
          transcriptCompactedThisTurn
          || getState().items.length + closingItems.length > itemsAtTurnStart;
        const reclaimed = cancelled && flags.activePromptRestore?.reclaimed === true;
        flags.activePromptRestore = null;
        const elapsedMs = Date.now() - startedAt;
        const thinkingElapsedMs = thinkingStartedAt ? accumulatedThinkingMs : 0;
        // responseLength is engine-local now (not pushed per-token), so compute the
        // fallback from the live accumulator instead of the possibly-stale
        // getState().spinner.responseLength. Final-only / non-streaming turns never
        // accumulate `assistantText` (only currentAssistantText is set at the
        // finalize reconcile above), so take the larger of the two text sources so
        // a no-usage turn still estimates tokens from the final content.
        const finalAssistantLen = Math.max(assistantText.length, currentAssistantText.length);
        const finalResponseLength = finalAssistantLen + thinkingText.length;
        const finalOutputTokens = Math.max(0, Number(getState().spinner?.outputTokens || 0), Math.round(finalResponseLength / 4));
        const turnStatus = cancelled ? 'cancelled' : 'done';
        const resultContent = askResult?.content != null ? String(askResult.content).trim() : '';
        const assistantOutput = (currentAssistantText || assistantText || '').trim();
        // Suppress only true pending-resume no-ops: no transcript items added and no model output; cancelled/error turns and any visible turn stay marked.
        const isNoOpTurn = turnFinishedNormally
          && !cancelled
          && toolCards.length === 0
          && !resultContent
          && !assistantOutput
          && !producedTranscriptItem;
        if (!isNoOpTurn) {
          getState().stats.turns = (getState().stats.turns || 0) + 1;
        }
        // Pin the post-think summary into the transcript right after this turn's
        // output so it scrolls up with the answer and stays in the scrollback,
        // in scrollback. (Previously TurnDone rendered only in the
        // bottom-fixed live-status slot and vanished on the next turn.)
        if (!reclaimed && !isNoOpTurn) {
          closingItems.push({ kind: 'turndone', id: nextId(), elapsedMs, status: turnStatus, outputTokens: finalOutputTokens, thinkingElapsedMs, verb: pickDoneVerb(turnIndex) });
        }
        // Deferred cards + turndone + status all land in ONE set() (one commit).
        appendItemsBatch(closingItems, {
          busy: false,
          spinner: null,
          thinking: null,
          lastTurn: null,
          stats: { ...getState().stats },
          ...routeState(),
          toolMode: runtime.toolMode,
          ...agentStatusState({ force: true }),
        });
        flushDeferredExecutionPendingResumeKick();
      }
    }
    // Shared UI getState(): a stale unwind must not wipe a newer turn's live
    // tool-summary line (same epoch rule as the shared-getState() block above).
    if (flags.leadTurnEpoch === turnEpoch) clearActiveToolSummary();
    _publishedThinkingActive = false; // turn teardown cleared getState().thinking
    tuiDebug(`runTurn end turn=${turnIndex} status=${cancelled ? 'cancelled' : 'done'} elapsedMs=${Date.now() - startedAt}${watchdogTripped ? ' watchdogTripped=1' : ''} pending=${pending.length}`);
    return cancelled ? 'cancelled' : 'done';
  }

  return runTurn;
}
