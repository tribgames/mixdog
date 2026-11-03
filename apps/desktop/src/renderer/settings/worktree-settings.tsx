// Settings → Worktrees: how Lead sessions create git worktrees and how
// finished ones are cleaned up (the list itself: worktree-list.tsx).
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { DesktopWorktreeSettings } from '../../shared/contract';
import { confirmAction } from '../app-confirm';
import { t } from '../i18n';
import { AutoSaveRow, Group, SelectRow, ToggleRow } from './capability-controls';
import {
  peekWorktreeSettings,
  saveWorktreeSettings,
  subscribeWorktreeSettings,
  watchWorktreeSettings,
} from './worktree-settings-store';

const GIB = 1024 ** 3;
const EXAMPLE_TASK = 'sidebar-fix';
const PRESET_PREFIX = 'mixdog/';
const MAX_WORKTREE_CHOICES = [5, 10, 15, 20, 30, 50];
const UNUSED_DAY_CHOICES = [7, 14, 30, 60, 90];

/** The offered choices, then the zero option. The setup tool and the config
 *  accept any integer within the schema bounds, so a saved value outside the
 *  choices gets its own option and the control shows what is really saved. */
export function choiceOptions(
  choices: readonly number[],
  current: number,
  label: (count: number) => string,
  zeroLabel: string
) {
  const counts = current === 0 || choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
  return [...counts.map((count) => ({ value: String(count), label: label(count) })), { value: '0', label: zeroLabel }];
}

/** The cached settings, revalidated while the dialog shows. */
export function useWorktreeSettings(active: boolean): DesktopWorktreeSettings | null {
  const settings = useSyncExternalStore(subscribeWorktreeSettings, peekWorktreeSettings, peekWorktreeSettings);
  // The cached value is the first frame; the host's current one replaces it
  // when it differs. The dialog keeps this page mounted while it is closed, so
  // watching follows the dialog showing, not the mount: every opening
  // revalidates, and a closed dialog reads nothing.
  useEffect(() => (active ? watchWorktreeSettings() : undefined), [active]);
  return settings;
}

/** A typed prefix as stored: a git ref path ending with "/" (the slash is
 *  optional when typed), "" for none; null when it is not a valid ref path. */
export function normalizeBranchPrefix(text: string): string | null {
  const value = text.trim().replace(/\/+$/, '');
  if (!value) return '';
  const valid =
    value.length < 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value) &&
    !value.includes('..') &&
    !value.split('/').some((part) => /\.lock$/i.test(part) || part.endsWith('.'));
  return valid ? `${value}/` : null;
}

/** Creation and cleanup groups, then the never-removed note. */
export function WorktreeSettings({ active = true }: { active?: boolean }) {
  const settings = useWorktreeSettings(active);
  if (!settings) return null;
  const save = saveWorktreeSettings;
  const off = !settings.autoCleanup;
  const countOptions = choiceOptions(
    MAX_WORKTREE_CHOICES,
    settings.maxWorktrees,
    (count) => t('{{count}} worktrees', { count }),
    t('No limit')
  );
  const dayOptions = choiceOptions(
    UNUSED_DAY_CHOICES,
    settings.unusedDays,
    (count) => t('{{count}} days', { count }),
    t('Never')
  );
  return (
    <>
      <Group title={t('Create')}>
        <SelectRow
          title={t('New task default')}
          description={t('Choose whether new tasks work in the project folder or in a separate worktree.')}
          showDescription
          value={settings.newTaskDefault}
          options={[
            { value: 'branch', label: t('Current branch') },
            { value: 'worktree', label: t('Worktree') },
          ]}
          onChange={(value) => save({ newTaskDefault: value as DesktopWorktreeSettings['newTaskDefault'] })}
        />
      </Group>
      <Group title={t('Cleanup')}>
        <ToggleRow
          title={t('Clean up finished worktrees automatically')}
          description={t(
            'Worktrees with uncommitted or unmerged work are never deleted. A branch Mixdog created goes with its worktree once git considers it merged; its commits stay reachable. Turning this off asks first.'
          )}
          showDescription
          checked={settings.autoCleanup}
          onChange={(autoCleanup) => {
            if (autoCleanup) {
              save({ autoCleanup });
              return;
            }
            void confirmAction(
              t('Turn off automatic cleanup?\nFinished worktrees stay on disk until you delete them.'),
              { confirmLabel: t('Turn off'), key: 'worktree-auto-cleanup-off' }
            ).then((confirmed) => {
              if (confirmed) save({ autoCleanup: false });
            });
          }}
        />
        <div className={`worktree-cleanup-sub${off ? ' is-off' : ''}`} aria-disabled={off || undefined}>
          <SelectRow
            title={t('Keep at most')}
            description={t('Beyond this, the least recently used are cleaned up first.')}
            showDescription
            value={String(settings.maxWorktrees)}
            disabled={off}
            options={countOptions}
            onChange={(value) => save({ maxWorktrees: Number(value) })}
          />
          <SelectRow
            title={t('Clean up worktrees unused for')}
            value={String(settings.unusedDays)}
            disabled={off}
            options={dayOptions}
            onChange={(value) => save({ unusedDays: Number(value) })}
          />
          <ToggleRow
            title={t("Clean up a session's worktrees when it is archived")}
            checked={settings.cleanupArchived}
            disabled={off}
            optimistic={false}
            onChange={(cleanupArchived) => save({ cleanupArchived })}
          />
        </div>
      </Group>
      <p className="worktree-cleanup-note">
        {t(
          'Favorite sessions, running sessions and worktrees created less than an hour ago are never cleaned up by any option.'
        )}
      </p>
    </>
  );
}

/** The collapsed "Advanced" group: branch prefix and the size warning. */
export function WorktreeAdvancedSettings({ active = true }: { active?: boolean }) {
  const settings = useWorktreeSettings(active);
  if (!settings) return null;
  return (
    <details className="worktree-advanced">
      <summary>{t('Advanced')}</summary>
      <Group>
        <BranchPrefixRows prefix={settings.branchPrefix} />
        <AutoSaveRow
          title={t('Size warning threshold (GB)')}
          name="worktreeSizeWarnGb"
          value={String(Math.round((settings.sizeWarnBytes / GIB) * 100) / 100)}
          placeholder="2"
          onSave={(value) => {
            const gb = Number(value.trim());
            if (Number.isFinite(gb) && gb >= 0) saveWorktreeSettings({ sizeWarnBytes: Math.round(gb * GIB) });
          }}
        />
      </Group>
    </details>
  );
}

type PrefixMode = 'none' | 'preset' | 'custom';

const modeOf = (prefix: string): PrefixMode =>
  prefix === '' ? 'none' : prefix === PRESET_PREFIX ? 'preset' : 'custom';

/** "None" (the task name alone), "mixdog/", or a typed prefix. */
function BranchPrefixRows({ prefix }: { prefix: string }) {
  // "Enter your own" with nothing valid typed yet stays chosen locally.
  const [customOpen, setCustomOpen] = useState(false);
  const [error, setError] = useState('');
  // The custom text as typed, for the live example (null: show the saved prefix).
  const [typed, setTyped] = useState<string | null>(null);
  const stored = modeOf(prefix);
  const mode: PrefixMode = customOpen ? 'custom' : stored;
  useEffect(() => {
    if (stored === 'custom') setCustomOpen(false);
  }, [stored]);
  const choose = (next: string) => {
    setError('');
    setTyped(null);
    if (next === 'custom') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    saveWorktreeSettings({ branchPrefix: next === 'preset' ? PRESET_PREFIX : '' });
  };
  const saved = mode === 'custom' && stored !== 'custom' ? '' : prefix;
  const shown = mode === 'custom' && typed !== null ? (normalizeBranchPrefix(typed) ?? typed) : saved;
  return (
    <>
      <SelectRow
        title={t('Branch prefix')}
        value={mode}
        options={[
          { value: 'none', label: t('None') },
          { value: 'preset', label: PRESET_PREFIX },
          { value: 'custom', label: t('Enter your own') },
        ]}
        onChange={choose}
      />
      {mode === 'custom' && (
        <AutoSaveRow
          title={t('Custom branch prefix')}
          name="worktreeBranchPrefix"
          value={stored === 'custom' ? prefix : ''}
          placeholder={t('e.g. team/')}
          onInput={(value) => {
            setTyped(value);
            if (normalizeBranchPrefix(value) !== null) setError('');
          }}
          onSave={(value) => {
            const next = normalizeBranchPrefix(value);
            if (next === null) {
              setError(t('Use letters, digits, ".", "_" or "-", separated by "/".'));
              return;
            }
            setError('');
            if (next === '') return;
            saveWorktreeSettings({ branchPrefix: next });
          }}
        />
      )}
      <p className="worktree-prefix-example" role={error ? 'alert' : undefined}>
        {error || t('Example: {{name}}', { name: `${shown}${EXAMPLE_TASK}` })}
      </p>
    </>
  );
}
