// Settings → Worktrees: creation, cleanup with its never-removed note, the
// worktree list, then the collapsed advanced group. The groups sit directly in
// the settings content so they take its shared spacing.
import { useSyncExternalStore } from 'react';
import { t } from '../i18n';
import { ActionButton } from './capability-controls';
import type { PanelContext } from './capability-data';
import { WorktreeList } from './worktree-list';
import { WorktreeAdvancedSettings, WorktreeSettings } from './worktree-settings';
import {
  peekWorktreeSettingsProblems,
  refreshWorktreeSettings,
  subscribeWorktreeSettingsProblems,
} from './worktree-settings-store';
import './worktrees-panel.css';

export function WorktreesPanel({ active = true }: Pick<PanelContext, 'active'>) {
  const problems = useSyncExternalStore(
    subscribeWorktreeSettingsProblems,
    peekWorktreeSettingsProblems,
    peekWorktreeSettingsProblems
  );
  return (
    <>
      {problems.save !== null && (
        <p className="settings-error" role="alert">
          {t('Could not save worktree settings.')} {problems.save}
        </p>
      )}
      {problems.read !== null && (
        <div className="settings-error" role="status">
          {t('Could not refresh worktree settings.')} {problems.read}{' '}
          <ActionButton onClick={() => void refreshWorktreeSettings()}>{t('Retry')}</ActionButton>
        </div>
      )}
      <WorktreeSettings active={active} />
      <WorktreeList active={active} />
      <WorktreeAdvancedSettings active={active} />
    </>
  );
}
