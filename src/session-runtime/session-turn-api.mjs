/**
 * src/session-runtime/session-turn-api.mjs - turn execution (ask) plus the
 * between-turn session and agent/tool-surface commands. Stateless
 * helpers are imported by the groups; the runtime injects live
 * getters/setters for the mutable session/mode/turn-counter/transcript-writer
 * locals plus the closure callbacks.
 */
import { createTurnRunner } from './turn/turn-run.mjs';
import { createSessionOps } from './turn/session-ops.mjs';
import { createCompactionGate } from './turn/compaction-gate.mjs';
import { createAgentOps } from './turn/agent-ops.mjs';
import { createSideQuestionOps } from './turn/side-question-ops.mjs';
import { createDevinHandoffApi } from './devin-handoff.mjs';

export function createSessionTurnApi(deps) {
  // A model-scheduled compaction runs chained after its turn; the next turn
  // and any manual compact/clear/rewind wait on it so nothing races it.
  const gate = createCompactionGate({ getSessionId: () => deps.getSession()?.id, compact: () => session.compact() });
  const afterCompaction = gate.after;
  const runner = createTurnRunner({ ...deps, runPendingCompact: gate.run });
  const session = createSessionOps(deps);
  const agent = createAgentOps(deps);
  const side = createSideQuestionOps(deps);
  const handoff = createDevinHandoffApi(deps);
  return {
    askSide: side.askSide,
    cancelSide: side.cancelSide,
    getTurnLiveness: runner.getTurnLiveness,
    ask: afterCompaction(runner.ask),
    clear: afterCompaction(session.clear),
    rewindMessages: afterCompaction(session.rewindMessages),
    compact: afterCompaction(session.compact),
    setToolMode: session.setToolMode,
    agentStatus: session.agentStatus,
    interruptTaskWait: session.interruptTaskWait,
    readModelMessages: session.readModelMessages,
    onAgentStatusChange: session.onAgentStatusChange,
    agentControl: agent.agentControl,
    taskControl: agent.taskControl,
    stopShellJob: agent.stopShellJob,
    releaseShellJob: agent.releaseShellJob,
    listShellJobs: agent.listShellJobs,
    onNotification: agent.onNotification,
    toolsStatus: agent.toolsStatus,
    selectTools: agent.selectTools,
    setCwd: session.setCwd,
    devinHandoff: handoff.devinHandoff,
  };
}
