// The agent task ids each `agent` tool call started (a spawn, or a send that
// began a new job), keyed by the tool call id: the agent tool records them
// from its own job objects (agent-tool spawn-flow/job-start.mjs) and the tool
// batch stores them on that call's result message as `agentTaskIds`
// (tool-batch/finalize.mjs) — the structured provenance a task session's
// report follows to the turns its agents' results wake.
const startsByCall = new Map();
const MAX_CALLS = 1000;

/** Record that tool call `toolCallId` started agent task `taskId`. */
export function recordAgentTaskStart(toolCallId, taskId) {
  const callId = String(toolCallId || '').trim();
  const id = String(taskId || '').trim();
  if (!callId || !id) return;
  const ids = startsByCall.get(callId) || [];
  if (!ids.includes(id)) ids.push(id);
  startsByCall.set(callId, ids);
  while (startsByCall.size > MAX_CALLS) startsByCall.delete(startsByCall.keys().next().value);
}

/** The task ids tool call `toolCallId` started (empty when none), forgotten once taken. */
export function takeAgentTaskStarts(toolCallId) {
  const callId = String(toolCallId || '').trim();
  const ids = startsByCall.get(callId) || [];
  startsByCall.delete(callId);
  return ids;
}
