// A group-room member's tool calls (session/agent-room.mjs). Reads run freely;
// anything that can change files or state asks the user through the ordinary
// approval flow, whatever the agent's own permission or hook rules say — even
// an agent that normally runs auto-approved. A hook's deny still wins.
// Opening a task session (`session create`) runs as freely as in the agent's
// home thread: it changes nothing itself, and the task session is the user's
// own coding Lead, whose every side effect follows its usual approval rules.
import { analyzeShellCommandEffects } from '../runtime/agent/orchestrator/tools/builtin/shell-analysis.mjs';

const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'find',
  'list',
  'code_graph',
  'load_tool',
  'skill',
  'Skill',
  'recall',
  'search_memories',
  'web_search',
  'web_fetch',
  'local_fetch',
  'image_fetch',
  'ask_user',
]);

export const ROOM_APPROVAL_REASON = 'Group-room members need your approval before changing anything.';

/** Whether `name(args)` only reads: a read-only tool, or a shell command whose
 *  every stage the shell analysis classifies as non-mutating. */
export async function isReadOnlyRoomCall({ name, args, cwd }, analyze = analyzeShellCommandEffects) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  if (name !== 'shell' || typeof args?.command !== 'string') return false;
  try {
    return (await analyze(args.command, cwd))?.mutationMode === 'none';
  } catch {
    return false;
  }
}

/** Whether `name(args)` opens a task session (session create). */
export function isTaskSessionCreate({ name, args }) {
  return (
    name === 'session' &&
    String(args?.action ?? '')
      .trim()
      .toLowerCase() === 'create'
  );
}

/** The PreToolUse decision for a room member's call: the hook's own `decision`
 *  when it denies, the call only reads, or it opens a task session; otherwise
 *  an approval ask that keeps any rewrite the hook made. */
export async function roomMemberToolDecision(call, decision, analyze) {
  const action = String(decision?.action || decision?.decision || '').toLowerCase();
  if (action === 'deny' || action === 'block') return decision;
  if (isTaskSessionCreate(call) || (await isReadOnlyRoomCall(call, analyze))) return decision;
  return { ...(decision && typeof decision === 'object' ? decision : {}), action: 'ask', reason: ROOM_APPROVAL_REASON };
}
