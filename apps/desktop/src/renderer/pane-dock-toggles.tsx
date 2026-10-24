// Pane strip dock toggles: ONE button per right-side dock child (session Diff,
// Browser Use, Terminal, …) at the strip's right end. The strip is
// the only place that names the pane's utility children now, so the dock header itself no longer
// repeats them. A press opens the dock on that child; pressing the child that
// is already showing folds the unit.
import { startTransition, useEffect, useState } from 'react';
import { FolderTree } from 'lucide-react';
import { t } from './i18n';
import { useDockVisibilityMenu } from './dock-icon-visibility';
import { isMobileRemoteSurface } from './mobile-surface';
import type {
  WorkbenchSideViewDescriptor,
  WorkbenchSideViewGroup,
  WorkbenchSideViewId,
} from './workbench-side-view-layout';

/** Session-owned surfaces need a session behind the pane; a New Task draft
 *  keeps their toggles visible but inert so the strip never reflows. */
export const SESSION_BOUND_VIEWS: readonly WorkbenchSideViewId[] = [
  'routines',
  'room',
  'session-diff',
  'visualize',
  'browser',
  'terminal',
];

export function PaneDockToggles({
  groups,
  descriptors,
  activeRoot,
  sessionBound,
  files,
  onSelect,
  onClose,
}: {
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  /** The child the pane's dock is showing, or null while it is folded. */
  activeRoot: WorkbenchSideViewId | null;
  sessionBound: boolean;
  /** The project Files tree child (the phone sheet header). Absent, no toggle. */
  files?: { active: boolean; onOpen(): void };
  onSelect(id: WorkbenchSideViewId): void;
  onClose(): void;
}) {
  const toggles = groups.flatMap((group) => {
    const root = group[0];
    const descriptor = root === undefined ? undefined : descriptors.get(root);
    return root !== undefined && descriptor ? [{ root, descriptor }] : [];
  });
  // Phone tap feedback: the pressed state is this component's own, set on the
  // tap, while the dock itself opens in a transition behind it — the heavy
  // pane render never gates the toggle's first frame. The tap is dropped when
  // the shell's own answer (activeRoot / files.active) arrives or after a beat.
  const [tapped, setTapped] = useState<{ root: WorkbenchSideViewId | 'files'; pressed: boolean } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shell's answer is the settle trigger; the body does not read it
  useEffect(() => setTapped(null), [activeRoot, files?.active]);
  useEffect(() => {
    if (!tapped) return undefined;
    const timer = window.setTimeout(() => setTapped(null), 1000);
    return () => window.clearTimeout(timer);
  }, [tapped]);
  const pressedOf = (root: WorkbenchSideViewId | 'files', shellPressed: boolean) =>
    tapped ? tapped.pressed && tapped.root === root : shellPressed;
  const press = (root: WorkbenchSideViewId | 'files', pressed: boolean, apply: () => void) => {
    if (!isMobileRemoteSurface()) return apply();
    setTapped({ root, pressed });
    startTransition(apply);
  };
  const filesLabel = t('Files');
  const { isVisible, menuProps, menu } = useDockVisibilityMenu(
    [
      ...(files ? [{ id: 'files', label: filesLabel }] : []),
      ...toggles.map(({ root, descriptor }) => ({ id: root, label: descriptor.tooltip || descriptor.label })),
    ],
    'Utility panel'
  );
  if (toggles.length === 0 && !files) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings its own border, padding and min-width into the toggle strip.
    <div
      className="pane-dock-toggles"
      role="group"
      aria-label={t('Utility panel')}
      {...menuProps}
      style={{ minWidth: 28, minHeight: 28 }}
    >
      {files && isVisible('files') && (
        <button
          type="button"
          className="pane-dock-toggle"
          aria-pressed={pressedOf('files', files.active)}
          aria-label={filesLabel}
          data-tooltip={
            files.active ? t('Close {{label}}', { label: filesLabel }) : t('Open {{label}}', { label: filesLabel })
          }
          onClick={() => {
            if (files.active) press('files', false, onClose);
            else press('files', true, files.onOpen);
          }}
        >
          <FolderTree size={15} aria-hidden="true" />
        </button>
      )}
      {toggles
        .filter(({ root }) => isVisible(root))
        .map(({ root, descriptor }) => {
          const Icon = descriptor.icon;
          const active =
            activeRoot !== null && (groups.find((group) => group[0] === root)?.includes(activeRoot) ?? false);
          const unavailable = !sessionBound && SESSION_BOUND_VIEWS.includes(root);
          const label = descriptor.tooltip || descriptor.label;
          return (
            <button
              key={root}
              type="button"
              className="pane-dock-toggle"
              data-view={root}
              aria-pressed={pressedOf(root, active)}
              aria-disabled={unavailable || undefined}
              aria-label={label}
              data-tooltip={active ? t('Close {{label}}', { label }) : t('Open {{label}}', { label })}
              onPointerEnter={descriptor.onPrefetch}
              onFocus={descriptor.onPrefetch}
              onPointerDown={(event) => {
                if (event.button === 0) descriptor.onPrefetch?.();
              }}
              onClick={() => {
                if (unavailable) return;
                if (active) press(root, false, onClose);
                else press(root, true, () => onSelect(root));
              }}
            >
              {/* Claude Desktop tier: a 16px mark in a 28px slot, slots set 6px apart. */}
              <Icon size={15} aria-hidden="true" />
            </button>
          );
        })}
      {menu}
    </div>
  );
}
