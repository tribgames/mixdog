// Per-turn tool cards for the lead TUI turn: which provider calls get a
// transcript card, standalone vs aggregate placement, results that arrive
// before their card exists, the task-wait spinner mode, and the live
// shell-output tail. `createTurnToolCards` returns one explicit state object
// (deps + collections); every function here takes it as its first argument.
import {
  aggregateToolCategoryEntries,
  classifyToolCategory,
  isTaskWaitToolCall,
} from '../../runtime/shared/tool-surface.mjs';
import {
  isTranscriptHiddenControlToolName,
  isTranscriptSkillToolName,
} from '../../runtime/shared/tool-execution-contract.mjs';
import { toolCallId, toolResultCallId, toolCallName, toolCallArgs } from './tool-call-fields.mjs';
import { aggregateBucketForCategory, mergeAggregateCategoryEntries } from './tool-result-status.mjs';
import { createDeferredCardRegistry } from './turn-deferred-cards.mjs';
import { createAggregateCardTracker } from './turn-aggregate-cards.mjs';

/**
 * `builtinSkillNames` (optional Set) lets a live turn hide a built-in skill
 * load before its result exists; restore paths use the result stub instead
 * (isTranscriptHiddenToolItem).
 */
export function transcriptToolCallDisplayMode(name, args, builtinSkillNames = null) {
  if (isTaskWaitToolCall(name, args)) return 'task-wait';
  if (isTranscriptHiddenControlToolName(name)) return 'hidden-control';
  if (builtinSkillNames?.size && isTranscriptSkillToolName(name)) {
    const skill = String(args?.name || args?.skill || args?.skill_name || '')
      .trim()
      .toLowerCase();
    if (skill && builtinSkillNames.has(skill)) return 'hidden-control';
  }
  return 'visible';
}

// Skill source lookup is a status read (a promise over the daemon wire), so
// it runs only when the batch actually carries a skill call.
export async function builtinSkillNamesFor(runtime, calls) {
  if (!calls.some((call) => isTranscriptSkillToolName(toolCallName(call)))) return null;
  try {
    const status = await Promise.resolve(runtime?.skillsStatus?.());
    const skills = Array.isArray(status?.skills) ? status.skills : [];
    return new Set(
      skills
        .filter((skill) => skill?.source === 'builtin')
        .map((skill) =>
          String(skill?.name || '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    );
  } catch {
    return null;
  }
}

// Transcript spec for a standalone (non-aggregated) tool card.
function standaloneCardSpec(itemId, name, args) {
  return {
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
  };
}

// One call's slot inside an aggregate card, before its result lands.
function aggregateCallEntry(callKey, name, args, category) {
  return {
    callId: callKey,
    name,
    args,
    category,
    summary: null,
    summarySeq: null,
    isError: false,
    isCallError: false,
    isExitError: false,
    exitCode: null,
    resultText: null,
    rawResultText: null,
    resolved: false,
    completedEarly: false,
    startedAt: Date.now(),
    completedAt: null,
  };
}

// deps: runtime, isCurrentTurn, flags, getState, set, nextId,
// appendItems, patchItem, itemIndexById, markToolCallActive, markToolCallDone,
// flushToolResults.
export function createTurnToolCards(deps) {
  const { isCurrentTurn, flags, appendItems, getState, set, itemIndexById, nextId, patchItem, markToolCallDone } = deps;
  const cards = {
    ...deps,
    cardByCallId: new Map(),
    toolCards: [],
    toolGroups: new Map(),
    resultsDone: new Set(),
    // Passive task waits and internal Goal/load controls are runtime flow,
    // not user-visible work. Keep ids only long enough to suppress result
    // cards.
    suppressedTranscriptCallIds: new Set(),
    activeTaskWaitCallIds: new Set(),
    // Streaming providers can deliver eager onToolResult before onToolCall
    // registers cards (send() still in flight). Hold those by callId until
    // the batch lands.
    earlyResultBuffer: new Map(),
    providerToolBatch: 0,
  };
  // Cards enter the transcript in call order once their headers are ready
  // (see turn-deferred-cards.mjs).
  cards.deferredCards = createDeferredCardRegistry({
    isCurrentTurn,
    flags,
    appendItems,
    getState,
    set,
    itemIndexById,
  });
  // Consecutive same-bucket calls merge into one aggregate card (see
  // turn-aggregate-cards.mjs).
  cards.aggregates = createAggregateCardTracker({
    toolCards: cards.toolCards,
    cardByCallId: cards.cardByCallId,
    nextId,
    getState,
    set,
    patchItem,
    itemIndexById,
    markToolCallDone,
    registerDeferredAggregate: cards.deferredCards.registerAggregate,
  });
  return cards;
}

export function taskWaitSpinnerMode(cards) {
  return cards.activeTaskWaitCallIds.size > 0 ? 'task-wait' : 'tool-use';
}

function refreshTaskWaitSpinner(cards) {
  const { getState, set } = cards;
  if (!getState().spinner) return;
  set({ spinner: { ...getState().spinner, mode: taskWaitSpinnerMode(cards) } });
}

// Hidden calls (skill loads, task waits) never get a card; their ids are
// remembered so their results route past the transcript.
export function visibleToolCalls(cards, batchCalls, builtinSkillNames) {
  const displayCalls = [];
  for (const call of batchCalls) {
    const displayMode = transcriptToolCallDisplayMode(toolCallName(call), toolCallArgs(call), builtinSkillNames);
    const callId = toolCallId(call);
    // Tool protocol calls normally always carry ids. If a malformed provider
    // omits one, keep the ordinary card so its result cannot strand an
    // unaddressable hidden spinner.
    if (displayMode === 'visible' || !callId) {
      displayCalls.push(call);
      continue;
    }
    cards.suppressedTranscriptCallIds.add(callId);
    if (displayMode === 'task-wait') cards.activeTaskWaitCallIds.add(callId);
  }
  return displayCalls;
}

// Opens the cards for one provider-emitted batch and makes the complete
// batch visible before the caller yields, preserving creation order.
export function openToolBatch(cards, displayCalls) {
  const batch = {
    // Agent actions aggregate only within this provider-emitted batch.
    agentBatch: ++cards.providerToolBatch,
    touchedAggregates: new Set(),
    // Last standalone (Agent) card in this batch to reserve a row for.
    // Flushed AFTER the syncAggregateHeader loop so any earlier-seq aggregate
    // it would flush-through already has its pendingSpec built.
    standaloneReserve: null,
    // A shell call that follows an edit call in the SAME provider batch is
    // its verification — the Shell card header renders Verifying/Verified.
    sawEditInBatch: false,
  };
  for (let i = 0; i < displayCalls.length; i++) openToolCard(cards, displayCalls[i], i, batch);
  for (const aggregateCard of batch.touchedAggregates) cards.aggregates.syncAggregateHeader(aggregateCard);
  batch.standaloneReserve?.ensureVisible?.();
  const lastTouchedAggregate = [...batch.touchedAggregates].at(-1) || null;
  lastTouchedAggregate?.ensureVisible?.();
  flushBufferedToolResults(cards);
}

function trackCard(cards, callId, card) {
  if (callId) cards.cardByCallId.set(callId, card);
  cards.toolCards.push(card);
}

// One provider tool call becomes a standalone card (Agent) or joins the
// batch's aggregate card for its category.
function openToolCard(cards, call, index, batch) {
  const name = toolCallName(call);
  const args = toolCallArgs(call);
  // Category drives the aggregate bucket so only same-category calls merge.
  const category = classifyToolCategory(name, args);
  const shellAfterEdit = category === 'Shell' && batch.sawEditInBatch;
  if (category === 'Patch' && args?.dry_run !== true) batch.sawEditInBatch = true;
  const bucket = aggregateBucketForCategory(category, { agentBatch: batch.agentBatch });
  const callId = toolCallId(call);
  const callKey = callId || `__tool_${cards.toolCards.length}_${index}`;
  // Multi-pattern calls count via category work units, not a flat 1, so the
  // incremental web-search summary matches.
  const categoryEntries = aggregateToolCategoryEntries(name, args, category);
  const activeCount = categoryEntries.reduce((total, entry) => total + Number(entry.count || 1), 0);
  cards.markToolCallActive(callKey, category, activeCount, Date.now());
  if (!bucket) {
    const itemId = cards.nextId();
    // Defer the visible push: the card enters the transcript when its real
    // header will paint (delay elapsed) or its result lands first, so no
    // blank placeholder height scrolls the body ahead of the glyphs.
    const card = { itemId, callId: callKey, done: false, pushed: false, spec: standaloneCardSpec(itemId, name, args) };
    cards.deferredCards.registerCard(card);
    trackCard(cards, callId, card);
    // Immediate row-reserve is deferred until every touched aggregate has its
    // pendingSpec (see openToolBatch); ensureVisible() here would flush an
    // earlier-seq aggregate before it is push-ready.
    batch.standaloneReserve = card;
    // A standalone card (Agent) breaks the consecutive run too: a later
    // same-bucket call must open a fresh card BELOW it.
    cards.aggregates.sealTail();
    return;
  }
  const aggregateCard = cards.aggregates.ensureAggregateCard(bucket);
  if (shellAfterEdit) aggregateCard.verifyShell = true;
  mergeAggregateCategoryEntries(aggregateCard, categoryEntries);
  aggregateCard.calls.set(callKey, aggregateCallEntry(callKey, name, args, category));
  batch.touchedAggregates.add(aggregateCard);
  trackCard(cards, callId, { itemId: aggregateCard.itemId, callId: callKey, done: false, aggregate: aggregateCard });
}

function deliverToolResultMessage(cards, message) {
  const callId = toolResultCallId(message);
  if (callId && cards.suppressedTranscriptCallIds.has(callId)) {
    cards.activeTaskWaitCallIds.delete(callId);
    refreshTaskWaitSpinner(cards);
    return;
  }
  if (message?.__earlyNotify === true) {
    if (callId) cards.aggregates.markToolCardCompletedState(callId, message);
    return;
  }
  cards.flushToolResults([message], cards.toolCards, cards.cardByCallId, cards.toolGroups, cards.resultsDone);
}

// Results that arrived before their card existed are delivered once the
// batch's cards are in place.
function flushBufferedToolResults(cards) {
  for (const [callId, message] of cards.earlyResultBuffer) {
    if (!cards.suppressedTranscriptCallIds.has(callId) && !cards.cardByCallId.has(callId)) continue;
    deliverToolResultMessage(cards, message);
    cards.earlyResultBuffer.delete(callId);
  }
}

export function receiveToolResult(cards, message) {
  const callId = toolResultCallId(message);
  if (callId && !cards.cardByCallId.has(callId) && !cards.resultsDone.has(callId)) {
    cards.earlyResultBuffer.set(callId, message);
    return;
  }
  deliverToolResultMessage(cards, message);
}

// Finalizes every card: results from the session transcript on a normal
// end, or a cancelled finalize so in-flight cards don't stay "Running..."
// forever after an abort.
export function finalizeToolCards(cards, messages, { cancelled = false } = {}) {
  const options = cancelled ? { finalize: true, cancelled: true } : { finalize: true };
  cards.flushToolResults(messages, cards.toolCards, cards.cardByCallId, cards.toolGroups, cards.resultsDone, options);
  cards.aggregates.finalizeToolHeaders();
}

// Flush any still-deferred tool cards into the transcript and cancel their
// pending push timers so nothing fires (or leaks) after the turn ends. The
// cards are collected (not emitted) so the turn-close flush and the turndone
// item land in ONE set(); a stale unwind only cancels the timers.
export function collectClosingCards(cards, stale) {
  if (!cards.deferredCards.hasEntries()) return [];
  const items = stale ? [] : cards.deferredCards.collectAll();
  cards.deferredCards.clearTimers();
  return items;
}

// 1 s poll of orchestrator liveness while this turn runs. When exactly one
// standalone (non-aggregate) card is unresolved and the runtime reports a
// fresh toolOutputTail for the running tool, patch it onto the card as
// `liveOutput` so transcript consumers (desktop) can render live command
// output. The result patch clears the field; the timer dies with the turn.
export function startLiveTail(cards) {
  let lastPatched = '';
  const timer = setInterval(() => {
    if (!cards.isCurrentTurn()) {
      clearInterval(timer);
      return;
    }
    let liveness = null;
    try {
      liveness = cards.runtime.getTurnLiveness?.();
    } catch {
      return;
    }
    if (liveness?.stage !== 'tool_running') return;
    const tail = typeof liveness.toolOutputTail === 'string' ? liveness.toolOutputTail : '';
    if (!tail || tail === lastPatched) return;
    const running = cards.toolCards.filter((c) => !c.done && !c.aggregate);
    if (running.length !== 1) return;
    // Real output proves the tool is genuinely running — surface the card
    // even if its deferred-display timer has not fired yet.
    running[0].ensureVisible?.();
    lastPatched = tail;
    cards.patchItem(running[0].itemId, { liveOutput: tail });
  }, 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
