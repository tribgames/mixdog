/**
 * Agent Runtime — Internal LLM Helper (session-based).
 *
 * Every one-shot LLM dispatch from internal callers (memory-cycle,
 * scheduler, webhook) now flows through the SAME session pipeline as the
 * MCP `agent` tool. No more parallel `provider.send()` helper — one code
 * path = one message shape = one usage log = "agent single path".
 *
 * The returned function uses the existing caller signature, so call sites
 * do not need changes:
 *
 *   const llm = makeAgentDispatch({ agent: 'maintenance', preset: 'haiku' });
 *   const text = await llm({ prompt });
 *
 * Internally it:
 *   1. Resolves the preset (explicit arg > opts.preset > hidden-role config)
 *   2. Creates or reuses a session via the session manager
 *   3. Applies stateless-reset for stateless profiles so the prefix handle
 *      stays warm while per-dispatch transcripts never leak
 *   4. Calls `askSession` → provider.send() → usage logged via
 *      `session/manager.mjs` (mode='active')
 *
 * The steps live under ./agent-dispatch/ (preset, session-prep, watchdog,
 * abort-link, turn, ask-args); this file wires them around the admission
 * lease.
 */

import { loadConfig } from '../config.mjs';
import { prepareAgentSession } from './session-builder.mjs';
import {
  askSession,
  updateSessionStatus,
  closeSession,
  getSession,
  linkParentSignalToSession,
} from '../session/manager.mjs';
import { resolveAgentWatchdogPolicy } from './agent-progress-watchdog.mjs';
import { resourceAdmission } from '../../../shared/resource-admission.mjs';
import { composeAgentDispatchAbortSignal } from './agent-dispatch/abort-link.mjs';
import { resolveDispatchPreset } from './agent-dispatch/preset.mjs';
import { prepareDispatchSession } from './agent-dispatch/session-prep.mjs';
import { runDispatchTurn } from './agent-dispatch/turn.mjs';
import { startDispatchWatchdog } from './agent-dispatch/watchdog.mjs';

export { resolveMaintenanceRoute } from './maintenance-route.mjs';
export { resolveHiddenRoleSchemaAllowedTools } from './agent-dispatch/session-prep.mjs';
export {
  resolveAgentDispatchLiveCallbacks,
  bindAgentDispatchHostCallbacks,
  buildAgentDispatchAskSessionArgs,
} from './agent-dispatch/ask-args.mjs';

/**
 * Build an agent-backed dispatch callback.
 *
 * @param {object} opts
 * @param {string} opts.agent       — REQUIRED; canonical agent name (worker, cycle1-agent, ...)
 * @param {string} [opts.taskType]  — optional internal classification stamped on the session
 * @param {string} [opts.preset]    — explicit preset override (bypasses agent → preset lookup)
 * @param {string} [opts.parentSessionId] — parent agent session for trace aggregation
 * @param {string|null} [opts.ownerSessionId] — owning Mixdog session for statusline isolation
 * @param {AbortSignal} [opts.parentSignal] — optional AbortSignal from the fan-out coordinator;
 *   when aborted the agent session's own controller is also aborted so the
 *   provider call tears down promptly (parent→child cascade).
 * @param {boolean} [opts.liveProjection] — request provider onTextDelta / mid-turn
 *   text for this Agent. Never persisted on the session.
 * @param {function} [opts.onSessionStart]
 * @param {function} [opts.onStageChange]
 * @param {function} [opts.onReasoningDelta]
 * @param {function} [opts.onTextDelta]
 * @param {function} [opts.onTextReset] — must return `true` to ack a retry retraction
 * @param {function} [opts.onAssistantText]
 * @param {function} [opts.onAssistantMessageCommitted]
 * @param {function} [opts.onToolCall]
 * @param {function} [opts.onToolResult]
 * @returns {(args: { prompt, preset?, sourceName?, liveProjection?, onSessionStart?, onStageChange?, onReasoningDelta?, onTextDelta?, onTextReset?, onAssistantText?, onAssistantMessageCommitted?, onToolCall?, onToolResult? }) => Promise<string>}
 */
export function makeAgentDispatch(opts = {}) {
  if (!opts.agent || typeof opts.agent !== 'string') {
    throw new Error('[agent-dispatch] opts.agent is required');
  }
  const agent = opts.agent;

  // Prepare → run → settle one ephemeral session under the admission lease.
  async function dispatchAdmitted(callArgs, { prepare, ask, updateStatus, close, readSession }) {
    const {
      prompt,
      preset: presetArg,
      sourceName: sourceNameArg,
      parentSignal: callParentSignal,
      idleTimeoutMs: callIdleTimeoutMs,
      cwd: callCwd,
    } = callArgs;
    const config = opts.config || loadConfig({ secrets: false });
    const { preset, presetName, runtimeSpec } = resolveDispatchPreset({
      presetArg,
      optsPreset: opts.preset,
      agent,
      config,
    });
    const { session, cwd } = prepareDispatchSession({
      agent,
      opts,
      callCwd,
      sourceNameArg,
      preset,
      presetName,
      runtimeSpec,
      prepare,
    });
    await updateStatus(session.id, 'running');
    const watchdog = startDispatchWatchdog({
      agent,
      sessionId: session.id,
      policy: resolveAgentWatchdogPolicy(agent, {
        idleTimeoutMs: Number.isFinite(callIdleTimeoutMs) ? callIdleTimeoutMs : opts.idleTimeoutMs,
        firstResponseTimeoutMs: opts.firstResponseTimeoutMs,
      }),
    });
    // Parent→child abort cascade: when opts.parentSignal (factory) or
    // callParentSignal (per-call) fires, abort the sub-session's own
    // controller so the provider call tears down promptly. Do not link
    // factory parent, per-call cancellation, and the watchdog one at a time:
    // each link replaces the previous listener in runtime-liveness. One
    // composite survives askSession's controller swap and makes every source
    // reach the provider call.
    const abortLink = composeAgentDispatchAbortSignal([opts.parentSignal, callParentSignal, watchdog.signal]);
    if (abortLink.signal) {
      try {
        linkParentSignalToSession(session.id, abortLink.signal);
      } catch {
        /* ignore */
      }
    }
    let terminalStatus = 'idle';
    let closeReason = 'ephemeral-done';
    process.stderr.write(
      `[agent-dispatch] agent=${agent} preset=${presetName} model=${preset.model} provider=${preset.provider} session=${session.id}\n`
    );
    try {
      return await runDispatchTurn({
        agent,
        session,
        prompt,
        cwd,
        opts,
        callArgs,
        ask,
        readSession,
        abortSignal: abortLink.signal,
      });
    } catch (err) {
      terminalStatus = 'error';
      closeReason = 'ephemeral-error';
      throw err;
    } finally {
      abortLink.dispose();
      watchdog.stop();
      // Always flip out of 'running' before returning so the sweep never
      // leaves a stateless Pool C session stuck in 'running' when the
      // try/catch falls through in unexpected ways.
      try {
        await updateStatus(session.id, terminalStatus);
      } catch {
        /* ignore */
      }
      // closeSession plants a tombstone, after which status writes are
      // rejected. Publish the terminal projection before closing so
      // live Agent panes cannot retain their preceding busy:true state.
      try {
        close(session.id, closeReason);
      } catch {
        /* ignore */
      }
    }
  }

  return async function agentDispatch(callArgs = {}) {
    const { prompt, parentSignal: callParentSignal, sessionId: callSessionId } = callArgs;
    if (typeof prompt !== 'string' || !prompt) {
      throw new Error(`[agent-dispatch] prompt required for agent "${agent}"`);
    }
    const deps = {
      prepare: typeof opts.prepareAgentSession === 'function' ? opts.prepareAgentSession : prepareAgentSession,
      ask: typeof opts.askSession === 'function' ? opts.askSession : askSession,
      updateStatus: typeof opts.updateSessionStatus === 'function' ? opts.updateSessionStatus : updateSessionStatus,
      close: typeof opts.closeSession === 'function' ? opts.closeSession : closeSession,
      readSession: typeof opts.getSession === 'function' ? opts.getSession : getSession,
    };
    const admission = opts.resourceAdmission || resourceAdmission;
    const admissionAbortLink = composeAgentDispatchAbortSignal([opts.parentSignal, callParentSignal]);
    let lease;
    try {
      lease = await admission.acquire('agent', {
        signal: admissionAbortLink.signal,
        label: agent,
        ownerKey: callSessionId || opts.ownerSessionId || opts.parentSessionId || opts.sessionId || null,
      });
    } catch (error) {
      admissionAbortLink.dispose();
      throw error;
    }
    try {
      const runAdmitted = (task) =>
        typeof admission.runWithLease === 'function' ? admission.runWithLease(lease, task) : task();
      return await runAdmitted(() => dispatchAdmitted(callArgs, deps));
    } finally {
      await lease.release();
      admissionAbortLink.dispose();
    }
  };
}
