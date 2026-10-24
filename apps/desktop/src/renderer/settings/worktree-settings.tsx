// Settings → General: how Lead sessions use git worktrees.
import { useEffect, useSyncExternalStore } from 'react';

import type { DesktopWorktreeSettings } from '../../shared/contract';
import { t } from '../i18n';
import { AutoSaveRow, Group, SelectRow, ToggleRow } from './capability-controls';
import {
  peekWorktreeSettings,
  saveWorktreeSettings,
  subscribeWorktreeSettings,
  watchWorktreeSettings,
} from './worktree-settings-store';

const GIB = 1024 ** 3;

export function WorktreeSettings({ active = true }: { active?: boolean }) {
  const settings = useSyncExternalStore(subscribeWorktreeSettings, peekWorktreeSettings, peekWorktreeSettings);
  // The cached value is the first frame; the host's current one replaces it
  // when it differs. The dialog keeps this page mounted while it is closed, so
  // watching follows the dialog showing, not the mount: every opening
  // revalidates, and a closed dialog reads nothing.
  useEffect(() => (active ? watchWorktreeSettings() : undefined), [active]);
  if (!settings) return null;
  const save = saveWorktreeSettings;
  return (
    <Group title={t('Worktree')}>
      <SelectRow
        title={t('New task default')}
        value={settings.newTaskDefault}
        options={[
          { value: 'branch', label: t('Current branch') },
          { value: 'worktree', label: t('Worktree') },
        ]}
        onChange={(value) => save({ newTaskDefault: value as DesktopWorktreeSettings['newTaskDefault'] })}
      />
      <AutoSaveRow
        title={t('Branch prefix')}
        name="worktreeBranchPrefix"
        value={settings.branchPrefix}
        required
        onSave={(value) => save({ branchPrefix: value.trim() })}
      />
      <AutoSaveRow
        title={t('Size warning threshold (GB)')}
        name="worktreeSizeWarnGb"
        value={String(Math.round((settings.sizeWarnBytes / GIB) * 100) / 100)}
        placeholder="2"
        onSave={(value) => {
          const gb = Number(value.trim());
          if (Number.isFinite(gb) && gb >= 0) save({ sizeWarnBytes: Math.round(gb * GIB) });
        }}
      />
      <ToggleRow
        title={t('Clean up finished worktrees automatically')}
        checked={settings.autoCleanup}
        onChange={(autoCleanup) => save({ autoCleanup })}
      />
    </Group>
  );
}
