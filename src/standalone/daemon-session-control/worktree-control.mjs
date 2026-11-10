import { SESSION_ID_PATTERN } from '../../runtime/agent/orchestrator/runtime-core/session-id.mjs';
import { assertWorktreeMutationAllowed } from '../../session-runtime/services/worktree-access.mjs';

// The workspace methods `worktree` reaches on another session (all on the
// session protocol's read/configure allowlists).
const WORKTREE_METHODS = new Set([
  'getBranchMenu',
  'requestWorktree',
  'selectBranch',
  'mergeWorkspace',
  'removeWorktree',
]);

/**
 * Another session's workspace for the git tool's worktree operations
 * (session-runtime/workspace/worktree-tool.mjs): one workspace method with
 * one input, through the same configure / read lanes the desktop uses. No
 * `ownTurn` ever crosses: the target must be idle. A change (anything but
 * the menu read) needs the caller's trusted scope (`callerScope`, from
 * worktree-access.mjs worktreeCallerScope) to be an attended conversation.
 */
export function createWorktreeControl(getSessionService) {
  return async function worktreeControl(args, caller, callerScope) {
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('session: session_id is required for action=worktree');
    if (sessionId === caller) throw new Error('session: worktree control must target another session');
    if (!WORKTREE_METHODS.has(args.method)) throw new Error(`session: unsupported worktree method "${args.method}"`);
    if (args.method !== 'getBranchMenu') assertWorktreeMutationAllowed(callerScope, `session: worktree ${args.method}`);
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    if (args.method === 'getBranchMenu') {
      return (await service.readSession({ sessionId, action: 'getBranchMenu', args: [] })).value;
    }
    const result = await service.configureSession(
      { sessionId, action: args.method, args: [args.input ?? {}] },
      { revision: 1 }
    );
    return result.value;
  };
}
