// The composer island's worktree segment: shown only while the session works
// in a managed worktree (or its worktree folder went missing). It names the
// worktree branch and the branch it came from; pressing it opens the app's ⋯
// menu grammar above it: View changes · Merge into <base> · Remove worktree.
// Running Merge or Remove, and any refusal, goes through the shared confirm popup.
import { GitFork, TriangleAlert } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { DesktopMergeWorkspaceResult, DesktopSessionWorkspace } from '../shared/contract';
import type { ComposerIslandFlash } from './ComposerIsland';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { captureRowMenuAnchor, positionRowMenu } from './row-menu-geometry';
import { SettingsConfirmDialog } from './settings/capability-controls';
import type { SettingsConfirmation } from './settings/capability-data';
import { invokeWorktree, worktreeFailure, worktreeFailureText } from './worktree-branch-model';

const MENU_ITEM = "[role='menuitem']:not(:disabled)";

export function WorktreeIslandSegment({
  sessionId,
  workspace,
  onViewChanges,
  onFlash,
}: {
  sessionId: string;
  /** The session's live workspace; the segment shows only for a worktree. */
  workspace: DesktopSessionWorkspace | null | undefined;
  /** Opens the session's changes (the files segment's own action). */
  onViewChanges?: () => void;
  /** A short island notice after a merge. */
  onFlash?: (flash: ComposerIslandFlash) => void;
}) {
  const [anchor, setAnchor] = useState<ReturnType<typeof captureRowMenuAnchor> | null>(null);
  const [dialog, setDialog] = useState<SettingsConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = anchor !== null;
  const recovery = workspace?.transition.state === 'recovery';
  const shown = Boolean(sessionId && workspace && (workspace.worktreeId || recovery));
  const close = () => setAnchor(null);
  useMobileBack(open && shown, close);

  // Same dismissal as the ⋯ menus: an outside press, Escape (focus back to
  // the segment), or anything that moves the anchor.
  useEffect(() => {
    if (!open) return undefined;
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>(MENU_ITEM)?.focus());
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) setAnchor(null);
    };
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setAnchor(null);
      trigger.current?.focus();
    };
    const dismissNow = () => setAnchor(null);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', dismissNow);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', dismissNow);
    };
  }, [open]);

  if (!shown || !workspace) return null;
  const branch = workspace.branch || t('Worktree');
  const slash = branch.lastIndexOf('/');
  const target = workspace.mergeTarget || '';

  const failed = (title: string, description: string) => setDialog({ title, description });
  const run = async (title: string, action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      failed(title, worktreeFailureText(worktreeFailure(reason)));
    } finally {
      setBusy(false);
    }
  };
  const merge = () =>
    run(t("Couldn't merge"), async () => {
      // Cleanup follows the worktree settings' automatic cleanup.
      const result = await invokeWorktree<DesktopMergeWorkspaceResult>(
        'mergeWorkspace',
        [{ confirmed: true, target, expectedRevision: workspace.revision, cleanup: true }],
        sessionId
      );
      if (!result.merged) {
        // The preflight found conflicts; nothing changed.
        failed(
          t("Couldn't merge"),
          worktreeFailureText({ code: 'MERGE_CONFLICT', message: '', details: { files: result.conflicts ?? [] } })
        );
        return;
      }
      onFlash?.({
        key: `worktree-merge:${result.commit ?? ''}:${workspace.revision}`,
        text: result.upToDate
          ? t('Nothing to merge into {{target}}', { target })
          : t('Merged {{source}} into {{target}}', { source: branch, target }),
      });
    });
  const remove = () =>
    run(t("Couldn't remove the worktree"), async () => {
      await invokeWorktree('removeWorktree', [{ expectedRevision: workspace.revision }], sessionId);
    });

  const items: { id: string; label: string; danger?: boolean; onSelect(): void }[] = [];
  if (!recovery && onViewChanges) {
    items.push({
      id: 'view-changes',
      label: t('View changes'),
      onSelect: () => {
        close();
        onViewChanges();
      },
    });
  }
  if (!recovery && target) {
    items.push({
      id: 'merge',
      label: t('Merge into {{value0}}', { value0: target }),
      onSelect: () => {
        close();
        setDialog({
          title: t('Merge {{source}} into {{target}}?', { source: branch, target }),
          description: t(
            'A merge commit joins the branches. The project folder must be on {{target}} with no uncommitted changes.',
            { target }
          ),
          confirmLabel: t('Merge'),
          // Cleanup follows the worktree settings' automatic cleanup.
          onConfirm: merge,
        });
      },
    });
  }
  items.push({
    id: 'remove',
    label: t('Remove worktree'),
    danger: true,
    onSelect: () => {
      close();
      setDialog({
        title: t('Remove this worktree?'),
        description: t(
          'The session returns to the project folder. Uncommitted or unmerged work blocks the removal.'
        ),
        confirmLabel: t('Remove'),
        danger: true,
        onConfirm: remove,
      });
    },
  });

  // positionRowMenu's horizontal rule (the right edge on the segment's), 4px
  // off. Like the composer's other menus it always opens upward, never over
  // the prompt; anchoring it from the bottom lets a notice grow upward.
  const { top: _below, ...placement } = positionRowMenu(anchor, items.length, 0, window.innerWidth, window.innerHeight);
  const style = { ...placement, bottom: window.innerHeight - (anchor?.bounds.top ?? 0) + 4 };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panel.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM) ?? [])];
    if (!entries.length) return;
    const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
    let next: number;
    if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
    else if (event.key === 'Tab') {
      close();
      return;
    } else return;
    event.preventDefault();
    entries[next]?.focus();
  };
  const tooltip = recovery
    ? t('Worktree missing')
    : target
      ? `${branch} · ${t('Branched from {{base}}', { base: target })}`
      : branch;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`composer-island-seg composer-island-seg-worktree${recovery ? ' composer-island-seg-warning' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tooltip}
        onClick={(event) => (open ? close() : setAnchor(captureRowMenuAnchor(event.currentTarget)))}
      >
        {recovery ? (
          <TriangleAlert size={14} className="composer-island-seg-icon" aria-hidden="true" />
        ) : (
          <GitFork size={14} className="composer-island-seg-icon" aria-hidden="true" />
        )}
        <span className="composer-island-seg-text">
          {recovery ? (
            t('Worktree missing')
          ) : (
            <>
              {slash > 0 && <span className="composer-island-seg-prefix">{branch.slice(0, slash + 1)}</span>}
              {branch.slice(slash + 1)}
            </>
          )}
        </span>
        {!recovery && target && <span className="composer-island-seg-sub">{target}</span>}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="row-overflow-menu worktree-island-menu"
            role="menu"
            aria-label={t('{{label}} menu', { label: t('Worktree') })}
            style={style}
            onKeyDown={onKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-action-id={item.id}
                className={item.danger ? 'danger' : undefined}
                disabled={busy}
                onClick={item.onSelect}
              >
                <span className="row-overflow-label">{item.label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
      {dialog && <SettingsConfirmDialog options={dialog} portal onClose={() => setDialog(null)} />}
    </>
  );
}
