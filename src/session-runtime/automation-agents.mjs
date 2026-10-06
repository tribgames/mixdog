/**
 * Agent delegation for automation sessions (schedules, webhooks). They run
 * headless in the daemon, so no session runtime registers tools for them or
 * receives their agents' completions. The daemon's canonical agent control is
 * exposed under a dedicated internal-tool scope instead, and the completions of
 * the agents a run starts come back here, where the run turns them into the
 * conversation's next turn — what a Lead in a window does when one arrives.
 */
import { setInternalToolsProvider } from '../runtime/agent/orchestrator/internal-tools.mjs';
import { AGENT_TOOL } from './services/agent-tool/tool-def.mjs';

export const AUTOMATION_TOOL_SCOPE = 'automation';
// How long a run waits for the next result of an agent it started; past it the
// run ends with the conversation as it stands.
const AGENT_RESULT_WAIT_MS = 60 * 60_000;

const runs = new Map(); // sessionId → { pending: Set<taskId>, ready: string[], wake }

function resultText(result) {
  return typeof result === 'string' ? result : JSON.stringify(result ?? '');
}

/** Registers the agent tool for automation sessions; returns its disposer. */
export function registerAutomationAgentTool(executeAgentControl) {
  return setInternalToolsProvider({
    scopeId: AUTOMATION_TOOL_SCOPE,
    tools: [AGENT_TOOL],
    async executor(_name, args, callerCtx = {}) {
      const result = await executeAgentControl(args, {
        callerCwd: callerCtx.callerCwd,
        invocationSource: 'model-tool',
        callerSessionId: callerCtx.callerSessionId || null,
        clientHostPid: process.pid,
        signal: callerCtx.signal,
      });
      // A spawn/send acknowledgement ("agent task: <id>", "status: running")
      // is a result still to come for this run.
      const text = resultText(result);
      const taskId = /agent task: ([\w.:-]+)/.exec(text)?.[1];
      const run = runs.get(String(callerCtx.callerSessionId || ''));
      if (run && taskId && /status: running/.test(text)) run.pending.add(taskId);
      return result;
    },
  });
}

/** Hands an agent completion to the automation run that started the task; false when none did. */
export function deliverAutomationCompletion(sessionId, text, meta = {}) {
  const run = runs.get(String(sessionId || ''));
  const taskId = String(meta?.execution_id || '');
  if (!run?.pending.has(taskId)) return false;
  // The header-only preview precedes the body-carrying completion.
  if (meta?.model_visible === false) return true;
  run.pending.delete(taskId);
  run.ready.push(String(text || ''));
  run.wake?.();
  return true;
}

/**
 * Runs an automation conversation to its end: the first turn, then one more
 * turn per batch of agent results while agents it started are still out.
 * Resolves with the last turn's result.
 */
export async function runAutomationTurns(sessionId, firstTurn, nextTurn, { waitMs = AGENT_RESULT_WAIT_MS } = {}) {
  const run = { pending: new Set(), ready: [], wake: null };
  runs.set(sessionId, run);
  try {
    let result = await firstTurn();
    while (run.pending.size > 0 || run.ready.length > 0) {
      if (run.ready.length === 0) {
        const arrived = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), waitMs);
          run.wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        run.wake = null;
        if (!arrived) break;
      }
      result = await nextTurn(run.ready.splice(0).join('\n\n'));
    }
    return result;
  } finally {
    runs.delete(sessionId);
  }
}
