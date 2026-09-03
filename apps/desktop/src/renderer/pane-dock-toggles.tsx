// Pane strip dock toggles: ONE button per right-side dock child (session Diff,
// Browser Use, Terminal, …) at the strip's right end. The strip is
// the only place that names the pane's utility children now (user: 터미널 /
// 웹 / 디프창을 스트립 아이콘 자리에), so the dock header itself no longer
// repeats them. A press opens the dock on that child; pressing the child that
// is already showing folds the unit.
import { t } from "./i18n";
import {
  isWorkbenchSideLauncher,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewGroup,
  type WorkbenchSideViewId,
} from "./workbench-side-view-layout";

/** Session-owned surfaces need a session behind the pane; a New Task draft
 *  keeps their toggles visible but inert so the strip never reflows. */
const SESSION_BOUND_VIEWS: readonly WorkbenchSideViewId[] = [
  "session-diff",
  "browser",
  "terminal",
];

export function PaneDockToggles({
  groups,
  descriptors,
  activeRoot,
  sessionBound,
  onSelect,
  onClose,
}: {
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  /** The child the pane's dock is showing, or null while it is folded. */
  activeRoot: WorkbenchSideViewId | null;
  sessionBound: boolean;
  onSelect(id: WorkbenchSideViewId): void;
  onClose(): void;
}) {
  const roots = groups
    .map((group) => group[0])
    .filter((root): root is WorkbenchSideViewId =>
      root !== undefined && descriptors.has(root) && !isWorkbenchSideLauncher(root));
  if (roots.length === 0) return null;
  return <div className="pane-dock-toggles" role="group" aria-label={t("Utility panel")}>
    {roots.map((root) => {
      const descriptor = descriptors.get(root)!;
      const Icon = descriptor.icon;
      const active = activeRoot !== null
        && (groups.find((group) => group[0] === root)?.includes(activeRoot) ?? false);
      const unavailable = !sessionBound && SESSION_BOUND_VIEWS.includes(root);
      const label = t(descriptor.tooltip || descriptor.label);
      return <button key={root} type="button"
        className="pane-dock-toggle"
        aria-pressed={active}
        aria-disabled={unavailable || undefined}
        aria-label={label}
        data-tooltip={active ? t("Close {{label}}", { label }) : t("Open {{label}}", { label })}
        onPointerEnter={descriptor.onPrefetch}
        onFocus={descriptor.onPrefetch}
        onClick={() => {
          if (unavailable) return;
          if (active) onClose();
          else onSelect(root);
        }}>
        {/* Claude Desktop tier (user: 클로드 대비 너무 조밀하고 큰 것 같다):
            a 16px mark in a 28px slot, slots set 6px apart. */}
        <Icon size={16} aria-hidden="true" />
      </button>;
    })}
  </div>;
}
