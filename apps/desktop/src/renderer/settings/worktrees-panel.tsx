// Settings → Worktrees (design/mockups/retention-settings frame A): creation,
// cleanup with its never-removed note, the worktree list, then the collapsed
// advanced group.
import type { PanelContext } from './capability-data';
import { WorktreeList } from './worktree-list';
import { WorktreeAdvancedSettings, WorktreeSettings } from './worktree-settings';
import './worktrees-panel.css';

export function WorktreesPanel({ active = true }: Pick<PanelContext, 'active'>) {
  return (
    <div className="worktrees-page">
      <WorktreeSettings active={active} />
      <WorktreeList active={active} />
      <WorktreeAdvancedSettings active={active} />
    </div>
  );
}
