// Whether a session working in `viewerCwd` sees work done in `targetCwd`: the
// two folders overlap, or they belong to one repository (a checkout and its
// linked worktrees share one git common dir).
import { findGitLayout } from './git-head.mjs';
import { isWithin, samePath } from './paths.mjs';

export function workspaceSees(targetCwd, viewerCwd) {
  if (!targetCwd || !viewerCwd) return false;
  try {
    if (isWithin(targetCwd, viewerCwd) || isWithin(viewerCwd, targetCwd)) return true;
    const target = findGitLayout(targetCwd);
    const viewer = findGitLayout(viewerCwd);
    return Boolean(target && viewer && samePath(target.commonDir, viewer.commonDir));
  } catch {
    return false;
  }
}
