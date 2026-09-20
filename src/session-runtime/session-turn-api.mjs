/**
 * src/session-runtime/session-turn-api.mjs - turn execution (ask) plus the
 * between-turn session, sharing, and agent/tool-surface commands. Stateless
 * helpers are imported by the groups; the runtime injects live
 * getters/setters for the mutable session/mode/turn-counter/transcript-writer
 * locals plus the closure callbacks.
 */
import { createTurnRunner } from './turn/turn-run.mjs';
import { createSessionOps } from './turn/session-ops.mjs';
import { createShareOps } from './turn/share-ops.mjs';
import { createAgentOps } from './turn/agent-ops.mjs';

export function createSessionTurnApi(deps) {
  const runner = createTurnRunner(deps);
  const session = createSessionOps(deps);
  const share = createShareOps(deps);
  const agent = createAgentOps(deps);
  return {
    enqueueRemoteAttachedPrompt: runner.enqueueRemoteAttachedPrompt,
    getTurnLiveness: runner.getTurnLiveness,
    ask: runner.ask,
    clear: session.clear,
    rewindMessages: session.rewindMessages,
    compact: session.compact,
    setToolMode: session.setToolMode,
    agentStatus: session.agentStatus,
    interruptTaskWait: session.interruptTaskWait,
    readModelMessages: session.readModelMessages,
    onAgentStatusChange: session.onAgentStatusChange,
    takeRemoteInjections: share.takeRemoteInjections,
    pendingSpoolPath: share.pendingSpoolPath,
    publishSessionPresence: share.publishSessionPresence,
    clearSessionPresence: share.clearSessionPresence,
    sessionOwnerGone: share.sessionOwnerGone,
    agentControl: agent.agentControl,
    taskControl: agent.taskControl,
    onNotification: agent.onNotification,
    toolsStatus: agent.toolsStatus,
    selectTools: agent.selectTools,
    setCwd: session.setCwd,
  };
}
