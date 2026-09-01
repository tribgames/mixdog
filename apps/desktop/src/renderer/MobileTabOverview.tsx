// Chrome-style full-screen tab overview. One grammar on every surface
// (PC/모바일 parity rule): desktop opens it from the same strip trigger, and a
// phone — whose projected 1040px viewport leaves no readable strip — uses it
// as the primary tab switcher with device-scale compensation.
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { DesktopSessionSummary } from "../shared/contract";
import type { WorkspaceTab } from "./nav-types";
import { t } from "./i18n";
import { prefetchSurfaceForSelection } from "./lazy-widgets";
import { isMobileRemoteSurface, mobileSurfaceScale } from "./mobile-surface";

export { isMobileRemoteSurface };

// Card centerpiece (user: 프레임 안이 검정으로 비어 있다): no page thumbnail
// exists on this surface, so the tab KIND fills the preview area as a large
// quiet glyph — Chrome-card composition without the screenshot machinery.
function tabKindGlyph(tab: WorkspaceTab): string {
  switch (tab.selection.kind) {
    case "file": return "file";
    case "diff": return "diff";
    case "terminal": return "terminal";
    case "studio": return "wand";
    case "pull-request": return "git-pull-request";
    case "new": return "add";
    default: return "comment-discussion";
  }
}

function tabKindMeta(tab: WorkspaceTab): string {
  const selection = tab.selection;
  switch (selection.kind) {
    case "file": return selection.rel;
    case "diff": return selection.rel;
    case "terminal": return t("Terminal");
    case "studio": return t("Studio");
    case "pull-request": return `#${selection.number}`;
    case "new": return t("New task");
    default: return "";
  }
}

/** Above this many tabs the switcher earns a filter field. Chrome has none;
 *  with three or four cards on screen it is pure chrome, and only a long tab
 *  list makes scanning slower than typing. */
const SEARCH_MIN_TABS = 8;

export function MobileTabOverview({
  tabs,
  activeKey,
  sessions,
  workingSessionIds,
  unreadSessionIds,
  onSelectTab,
  onCloseTab,
  onNewTask,
  onClose,
}: {
  tabs: WorkspaceTab[];
  activeKey: string;
  /** Session catalog: a conversation card shows the session's own preview
   *  line, which is what a page thumbnail would have carried in Chrome. */
  sessions?: readonly DesktopSessionSummary[];
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  onNewTask(): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  // iOS already exposes device-width layout pixels, including after rotation;
  // only legacy projected Android surfaces need counter-scaling. The factor is
  // derived from the CURRENT viewport, so it has to be re-read while the
  // overview is open: memoizing it for the component's lifetime left the
  // surface sized for the pre-rotation orientation.
  const [scale, setScale] = useState(mobileSurfaceScale);
  useEffect(() => {
    const sync = (): void => setScale((current) => {
      const next = mobileSurfaceScale();
      return current === next ? current : next;
    });
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      viewport?.removeEventListener("resize", sync);
    };
  }, []);
  const sessionRows = useMemo(
    () => new Map((sessions ?? []).map((session) => [session.id, session] as const)),
    [sessions],
  );
  // The card body: what this tab IS, in the tab's own words. A generated
  // session title is derived FROM the preview, so an identical preview would
  // print the same sentence twice and is dropped for the project instead.
  const cardText = useCallback((tab: WorkspaceTab): string => {
    if (tab.selection.kind !== "session") return tabKindMeta(tab);
    const row = sessionRows.get(tab.selection.id);
    const preview = String(row?.preview || "").trim();
    if (preview && preview !== tab.title) return preview;
    const location = String(row?.projectPath || row?.cwd || "").trim();
    return location
      ? location.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? ""
      : "";
  }, [sessionRows]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tabs;
    return tabs.filter((tab) =>
      (tab.title || "").toLowerCase().includes(needle)
      || cardText(tab).toLowerCase().includes(needle));
  }, [cardText, query, tabs]);
  return createPortal(
    <div className="mobile-tab-overview" role="dialog" aria-label={t("Tabs")}>
      <div className="mobile-tab-overview-scale" style={{
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
      }}>
        {/* Chrome's switcher toolbar: count leads, actions cluster at the
            trailing edge (user: 셋이 흩어져 어디를 눌러야 할지 모호). */}
        <header className="mobile-tab-overview-head">
          <button type="button" className="mobile-tab-overview-count"
            aria-label={t("Back to the current tab")}
            onClick={onClose}>
            <i>{tabs.length}</i>
          </button>
          <span className="mobile-tab-overview-spacer" />
          <button type="button" className="mobile-tab-overview-new"
            aria-label={t("New task")}
            onClick={() => {
              onClose();
              onNewTask();
            }}>
            <Plus size={22} aria-hidden="true" />
          </button>
          <button type="button" className="mobile-tab-overview-close"
            aria-label={t("Close tab overview")}
            onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        {tabs.length > SEARCH_MIN_TABS && <input className="mobile-tab-overview-search"
          type="search"
          placeholder={t("Search tabs")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />}
        <div className="mobile-tab-overview-grid">
          {visible.map((tab) => {
            const sessionId = tab.selection.kind === "session" ? tab.selection.id : "";
            const working = Boolean(sessionId && workingSessionIds?.has(sessionId));
            const unread = Boolean(sessionId && unreadSessionIds?.has(sessionId));
            const text = cardText(tab);
            return <section key={tab.key} className="mobile-tab-card"
              data-active={tab.key === activeKey ? "true" : undefined}>
              <button type="button" className="mobile-tab-card-open"
                // No hover exists here, so the tab's chunk used to start
                // downloading only after the card was released and the
                // overview had closed. The touch itself is the intent, and it
                // buys the fetch the press + close animation as a head start.
                onPointerDown={() => prefetchSurfaceForSelection(tab.selection)}
                onClick={() => {
                  onClose();
                  onSelectTab(tab);
                }}>
                <span className="mobile-tab-card-head">
                  <span className={`codicon codicon-${tabKindGlyph(tab)}`} aria-hidden="true" />
                  <b>{tab.title || t("New task")}</b>
                </span>
                <p className="mobile-tab-card-preview">{text}</p>
                {working
                  ? <span className="mobile-tab-card-state is-working">{t("Working…")}</span>
                  : unread
                    ? <span className="mobile-tab-card-state is-unread">{t("Updated")}</span>
                    : null}
              </button>
              {/* Sibling, not a nested button: the close target owns the
                  trailing corner at a full 44dp while its glyph stays small. */}
              <button type="button" className="mobile-tab-card-close"
                aria-label={t("Close tab")}
                onClick={() => onCloseTab(tab)}>
                <X size={16} aria-hidden="true" />
              </button>
            </section>;
          })}
          {visible.length === 0 && <p className="mobile-tab-overview-empty">
            {t("No matching tabs")}
          </p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
