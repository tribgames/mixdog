// Settings → General: how Lead sessions use git worktrees.
import { useEffect, useState } from 'react';

import type { DesktopWorktreeSettings } from '../../shared/contract';
import { t } from '../i18n';
import { invokeWorktree } from '../worktree-branch-model';
import { AutoSaveRow, Group, SelectRow, ToggleRow } from './capability-controls';

const GIB = 1024 ** 3;

export function WorktreeSettings() {
  const [settings, setSettings] = useState<DesktopWorktreeSettings | null>(null);
  useEffect(() => {
    let live = true;
    invokeWorktree<DesktopWorktreeSettings>('getWorktreeSettings')
      .then((value) => live && setSettings(value))
      .catch(() => {
        // A backend without worktree support has nothing to configure.
      });
    return () => {
      live = false;
    };
  }, []);
  if (!settings) return null;
  const save = (patch: Partial<DesktopWorktreeSettings>) => {
    const previous = settings;
    setSettings({ ...settings, ...patch });
    invokeWorktree<DesktopWorktreeSettings>('setWorktreeSettings', [patch])
      .then(setSettings)
      .catch(() => setSettings(previous));
  };
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
