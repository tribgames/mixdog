// Live execution root of a daemon entry. `entry.cwd` is captured at creation;
// a workspace transition moves the session's cwd without recreating the entry,
// so the projected `state.workspace` (cwd + revision) is the authority and the
// entry mirrors it every time a state is projected.

/** Mirror `state.workspace` onto the entry; states without one change nothing. */
export function syncEntryWorkspace(entry, state) {
  const workspace = state?.workspace;
  if (!entry || !workspace || typeof workspace !== 'object') return;
  if (typeof workspace.cwd === 'string' && workspace.cwd) entry.cwd = workspace.cwd;
  if (Number.isSafeInteger(workspace.revision) && workspace.revision >= 0) {
    entry.workspaceRevision = workspace.revision;
  }
}
