import type { HTMLAttributes } from 'react';
import { Check, FileText, Undo2 } from 'lucide-react';

import type { DesktopGitFile } from '../shared/contract';
import { actionTitle, type ScmContextMenuItem } from './ScmContextMenu';
import { fileBaseName } from './text-format';
import { ScmPathText } from './ScmPathText';
import { ScmStatusIcon } from './ScmStatusIcon';
import { statusKind } from './source-control-support';
import { t } from './i18n';

export function changedFileMenuItems({
  file,
  busy,
  canRevert,
  canIgnore,
  canReveal,
  canOpenDefault,
  missingChannel,
  guarded,
  onDiscard,
  onIgnore,
  onCopyFilePath,
  onCopyRelativePath,
  onReveal,
  onOpenDefault,
}: {
  file: DesktopGitFile;
  busy: boolean;
  canRevert: boolean;
  canIgnore: boolean;
  canReveal: boolean;
  canOpenDefault: boolean;
  missingChannel(label: string): string;
  guarded(action: () => void): void;
  onDiscard(): void;
  onIgnore(path: string, scope?: 'extension'): void;
  onCopyFilePath(): void;
  onCopyRelativePath(): void;
  onReveal(): void;
  onOpenDefault(): void;
}): ScmContextMenuItem[] {
  const slash = file.path.lastIndexOf('/');
  const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const folder = slash >= 0 ? file.path.slice(0, slash) : '';
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot) : '';
  return [
    {
      id: 'discard',
      label: t('Discard changes…'),
      danger: true,
      disabled: busy || file.conflicted || !canRevert,
      title: actionTitle(
        file.conflicted ? t('Resolve the conflict before discarding this file') : undefined,
        canRevert,
        () => missingChannel(t('Discarding changes'))
      ),
      onSelect: () => guarded(onDiscard),
    },
    {
      id: 'ignore-file',
      label: t('Ignore file (add to .gitignore)'),
      separatorBefore: true,
      disabled: busy || !canIgnore,
      title: canIgnore ? undefined : missingChannel(t('Ignoring a file')),
      onSelect: () => guarded(() => onIgnore(file.path)),
    },
    {
      id: 'ignore-folder',
      label: t('Ignore folder (add to .gitignore)'),
      disabled: busy || !canIgnore || !folder,
      title: actionTitle(
        folder ? undefined : t('This file sits at the repository root, so it has no folder to ignore'),
        canIgnore,
        () => missingChannel(t('Ignoring a folder'))
      ),
      onSelect: () => guarded(() => onIgnore(folder)),
    },
    {
      id: 'ignore-extension',
      label: t('Ignore all {{value0}} files (add to .gitignore)', { value0: extension || t('extensionless') }),
      disabled: busy || !canIgnore || !extension,
      title: actionTitle(
        extension ? undefined : t('This file has no extension, so there is no file type to ignore'),
        canIgnore,
        () => missingChannel(t('Ignoring a file type'))
      ),
      onSelect: () => guarded(() => onIgnore(file.path, 'extension')),
    },
    {
      id: 'copy-file-path',
      label: t('Copy file path'),
      separatorBefore: true,
      onSelect: onCopyFilePath,
    },
    {
      id: 'copy-relative-path',
      label: t('Copy relative file path'),
      onSelect: onCopyRelativePath,
    },
    {
      id: 'reveal',
      label: t('Show in Explorer'),
      separatorBefore: true,
      disabled: !canReveal,
      title: canReveal ? undefined : missingChannel(t('Showing a file in Explorer')),
      onSelect: onReveal,
    },
    {
      id: 'open-default',
      label: t('Open with default program'),
      disabled: !canOpenDefault,
      title: canOpenDefault ? undefined : missingChannel(t('Opening a file')),
      onSelect: onOpenDefault,
    },
  ];
}

export function SourceControlFileRow({
  file,
  included,
  selected,
  busy,
  contextMenuProps,
  onSetIncluded,
  onToggleSelected,
  onOpenChange,
  onOpenFile,
  onResolve,
  onDiscard,
}: {
  file: DesktopGitFile;
  included: boolean;
  selected: boolean;
  busy: boolean;
  contextMenuProps: HTMLAttributes<HTMLDivElement>;
  onSetIncluded(included: boolean): void;
  onToggleSelected(additive: boolean): void;
  onOpenChange(): void;
  onOpenFile(): void;
  onResolve(): void;
  onDiscard(): void;
}) {
  const fileName = fileBaseName(file.path);
  const displayName = file.oldPath ? `${fileBaseName(file.oldPath)} → ${fileName}` : fileName;
  const kind = statusKind(file);
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus lives on the row's own checkbox and buttons; making the row focusable would change keyboard flow
    <div
      className="dock-scm-file"
      data-selected={selected || undefined}
      data-conflicted={file.conflicted || undefined}
      role="treeitem"
      aria-selected={selected}
      {...contextMenuProps}
    >
      <input
        type="checkbox"
        className="dock-scm-file-check"
        checked={included}
        disabled={file.conflicted || busy}
        aria-label={t('Include {{value0}} in the commit', { value0: file.path })}
        onChange={(event) => onSetIncluded(event.currentTarget.checked)}
      />
      <button
        type="button"
        className="dock-scm-file-main"
        title={file.path}
        data-status={kind}
        aria-label={t('Open changes {{value0}}', { value0: file.path })}
        onClick={(event) => {
          const additive = event.ctrlKey || event.metaKey;
          onToggleSelected(additive);
          if (!additive && !event.shiftKey) onOpenChange();
        }}
      >
        <ScmPathText path={file.path} name={displayName} />
      </button>
      <ScmStatusIcon kind={kind} className="dock-scm-file-state" />
      <div className="dock-scm-file-actions">
        <button type="button" aria-label={t('Open file {{value0}}', { value0: file.path })} onClick={onOpenFile}>
          <FileText size={14} aria-hidden="true" />
        </button>
        {file.conflicted ? (
          <button
            type="button"
            aria-label={t('Mark resolved {{value0}}', { value0: file.path })}
            disabled={busy}
            onClick={onResolve}
          >
            <Check size={14} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            aria-label={t('Discard changes {{value0}}', { value0: file.path })}
            disabled={busy}
            onClick={onDiscard}
          >
            <Undo2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
