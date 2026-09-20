/**
 * src/session-runtime/lifecycle/inheritance.mjs - session inheritance
 * (/inherit): fit preflight and the carry of another session's conversation
 * into the freshly created heir.
 */
import { hasUserConversationMessage } from '../../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { stripEffortConfiguration } from '../../runtime/agent/orchestrator/providers/effort-configuration.mjs';
import { inheritedCompatReplayMessages } from '../../runtime/agent/orchestrator/providers/compat-request-policy.mjs';
import {
  inheritableMessages,
  inheritanceCompactionPlan,
  inheritanceFit,
  inheritanceFitMessage,
  inheritanceRouteTarget,
} from '../inheritance-fit.mjs';
import { clean } from '../session-text.mjs';

export function createInheritance(deps, { compactConversation, saveSession }) {
  const { getSession, getRoute, mgr, createCurrentSession, invalidateContextStatusCache, getReservedSessionId } = deps;

  /**
   * Compact a conversation FOR a heir: the source's transcript, the heir's
   * budget, and no mutation of either session. Returns the conversation to
   * carry, or null when the route has no boundary to compact toward.
   */
  async function compactConversationForHeir(source, target) {
    const plan = inheritanceCompactionPlan(target);
    if (!plan) return null;
    // The compactor sees the whole transcript — system blocks included — so it
    // preserves the protected head and the recent tail exactly as /compact
    // does. Only the conversation half of the result travels.
    const messages = structuredClone(Array.isArray(source.messages) ? source.messages : []);
    const result = await compactConversation({
      session: source,
      messages,
      ...plan,
      // Memory ingest belongs to the session that HELD the conversation; the
      // heir does not exist on disk with these messages yet.
      sessionId: source.id,
    });
    const compacted = inheritableMessages(result?.messages);
    return compacted.length && hasUserConversationMessage(compacted) ? compacted : null;
  }

  // Too large for the heir is not a dead end: carry a compacted conversation
  // instead of sending the user away to run /compact by hand. The compaction
  // is sized for the HEIR and runs on a copy, so the source session keeps
  // every message it has.
  async function fitConversationForHeir(source, target, carried, fit) {
    let compactionFault = null;
    let compacted = null;
    try {
      compacted = await compactConversationForHeir(source, target);
    } catch (reason) {
      // A compaction that cannot run is a refusal, not a half-carry: the
      // user reads the same measured sentence they would have read without
      // the attempt, and the engine fault travels along as its cause.
      compactionFault = reason;
    }
    let next = carried;
    let nextFit = fit;
    if (compacted) {
      next = compacted;
      nextFit = inheritanceFit(next, target);
    }
    if (nextFit.known && !nextFit.fits) {
      const refusal = new Error(inheritanceFitMessage(nextFit));
      if (compactionFault) refusal.cause = compactionFault;
      throw refusal;
    }
    return next;
  }

  // Display-only boundary: preserve the carried message and its historical
  // route, without adding a synthetic message to the model conversation.
  function recordInheritanceBoundary(target, source) {
    const boundary = target.messages.at(-1);
    const inheritance = {
      sourceSessionId: source.id,
      sessionId: target.id,
      provider: target.provider,
      modelId: target.model,
      at: target.updatedAt,
    };
    boundary.meta = {
      ...boundary.meta,
      sessionInheritances: [
        ...(Array.isArray(boundary.meta?.sessionInheritances) ? boundary.meta.sessionInheritances : []),
        inheritance,
      ],
    };
  }

  /**
   * Read-only twin of inheritFrom(): the exact verdict the carry will reach,
   * for the route the heir will open on. Surfaces ask this BEFORE offering
   * the action, so a conversation that cannot fit is named in their own
   * words instead of arriving as an engine error once a heir already exists.
   */
  function inheritancePreflight(sourceSessionId = null, selection = null) {
    const route = getRoute() || {};
    const requested = selection && typeof selection === 'object' ? selection : {};
    const provider = clean(requested.provider) || clean(route.provider);
    const model = clean(requested.model) || clean(route.model);
    const session = getSession();
    const id = clean(sourceSessionId) || clean(session?.id);
    const source = id && id === clean(session?.id) ? session : mgr.getSession(id);
    const target = inheritanceRouteTarget({
      provider,
      model,
      // A picked window belongs to the route that picked it; another
      // provider/model pair falls back to that model's own default.
      selectedContextWindow:
        provider === clean(route.provider) && model === clean(route.model) ? route.selectedContextWindow : null,
      tools: Array.isArray(session?.tools) ? session.tools : [],
    });
    const fit = inheritanceFit(source?.messages, target);
    // An oversized conversation is compacted for the heir rather than
    // refused, so the surface announces the extra step instead of blocking.
    const willCompact = fit.known && !fit.fits && Boolean(inheritanceCompactionPlan(target));
    return {
      ...fit,
      willCompact,
      sourceSessionId: id || null,
      reason: fit.known && !fit.fits && !willCompact ? inheritanceFitMessage(fit) : '',
    };
  }

  /**
   * Session inheritance (/inherit): carry another session's conversation
   * into THIS freshly created session, so the transcript continues under a
   * new id on the currently selected model.
   *
   * The source file is never touched — the two histories share a prefix and
   * then diverge, which is the whole point of inheriting instead of
   * switching the live session's route.
   *
   * The target must still be empty: interleaving two transcripts would
   * produce a conversation neither model ever had.
   */
  async function inheritFrom(sourceSessionId) {
    const id = clean(sourceSessionId);
    if (!id) throw new TypeError('inheritFrom: source session id is required');
    // A daemon-created heir is still only RESERVED when the desktop calls
    // this: reserveSessionId starts the materializing create in the
    // background. Join that single-flight instead of rejecting a session
    // that is about to exist. (The TUI path already ran newSession().)
    if (!getSession()?.id && clean(getReservedSessionId?.()) && typeof createCurrentSession === 'function') {
      await createCurrentSession('inherit');
    }
    const target = getSession();
    if (!target?.id) throw new Error('inheritFrom: no session is open');
    if (target.id === id) throw new Error('inheritFrom: a session cannot inherit from itself');
    if (hasUserConversationMessage(target.messages) || hasUserConversationMessage(target.liveTurnMessages)) {
      throw new Error('inheritFrom: this session already holds a conversation');
    }
    const source = mgr.getSession(id);
    if (!source) throw new Error(`inheritFrom: session ${id} was not found`);
    // System blocks belong to the session that BUILT them: the target's own
    // prompt was composed for the current model, tool surface, and workflow.
    // Only the conversation itself travels.
    let carried = inheritableMessages(source.messages);
    if (!hasUserConversationMessage(carried)) {
      throw new Error('inheritFrom: the source session has no conversation to carry');
    }
    // Decide BEFORE anything moves, on the heir's own scale. This is the
    // same function inheritancePreflight() answers with, so the surface that
    // offered the carry and the runtime that performs it cannot disagree —
    // and a refusal no longer has to unwind a half-filled transcript.
    const fit = inheritanceFit(carried, target);
    if (fit.known && !fit.fits) carried = await fitConversationForHeir(source, target, carried, fit);
    target.messages.push(
      ...stripEffortConfiguration(inheritedCompatReplayMessages(structuredClone(carried), source.provider))
    );
    invalidateContextStatusCache();
    target.inheritedFromSessionId = source.id;
    target.updatedAt = Date.now();
    recordInheritanceBoundary(target, source);
    if (!clean(target.title) && clean(source.title)) target.title = source.title;
    saveSession(target, { immediate: true });
    invalidateContextStatusCache();
    return {
      sessionId: target.id,
      sourceSessionId: source.id,
      messages: carried.length,
      provider: target.provider,
      model: target.model,
    };
  }

  return { inheritancePreflight, inheritFrom };
}
