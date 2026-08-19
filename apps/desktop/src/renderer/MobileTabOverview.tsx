// Chrome-style full-screen tab overview. One grammar on every surface
// (PC/모바일 parity rule): desktop opens it from the same strip trigger, and a
// phone — whose projected 1040px viewport leaves no readable strip — uses it
// as the primary tab switcher with device-scale compensation.
import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { WorkspaceTab } from "./nav-types";
import { t } from "./i18n";
import { isMobileRemoteSurface, mobileSurfaceScale } from "./mobile-surface";

export { isMobileRemoteSurface };

// Card centerpiece (user: 프레임 안이 검정으로 비어 있다): no page thumbnail
// exists on this surface, so the tab KIND fills the preview area as a large
// quiet glyph — Chrome-card composition without the screenshot machinery.
function tabKindGlyph(tab: WorkspaceTab): string {
  switch (tab.selection.kind) {
    case "file": return "file";
    case "diff": return "diff";
    case "folder": return "folder";
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
    case "folder": return selection.path;
    case "terminal": return t("Terminal");
    case "studio": return t("Studio");
    case "pull-request": return `#${selection.number}`;
    case "new": return t("New task");
    default: return "";
  }
}

export function MobileTabOverview({
  tabs,
  activeKey,
  workingSessionIds,
  unreadSessionIds,
  onSelectTab,
  onCloseTab,
  onNewTask,
  onClose,
}: {
  tabs: WorkspaceTab[];
  activeKey: string;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  onNewTask(): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  // iOS already exposes device-width layout pixels, including after rotation;
  // only legacy projected Android surfaces need counter-scaling.
  const scale = useMemo(() => mobileSurfaceScale(), []);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tabs;
    return tabs.filter((tab) =>
      (tab.title || "").toLowerCase().includes(needle)
      || tabKindMeta(tab).toLowerCase().includes(needle));
  }, [query, tabs]);
  return createPortal(
    <div className="mobile-tab-overview" role="dialog" aria-label={t("Tabs")}>
      <div className="mobile-tab-overview-scale" style={{
        transform: `scale(${scale})`,
        transformOrigin: "top left",
        width: `${100 / scale}%`,
        height: `${100 / scale}%`,
      }}>
        <header className="mobile-tab-overview-head">
          <button type="button" className="mobile-tab-overview-new"
            aria-label={t("New task")}
            onClick={() => {
              onClose();
              onNewTask();
            }}>
            <Plus size={22} aria-hidden="true" />
          </button>
          <button type="button" className="mobile-tab-overview-count"
            aria-label={t("Back to the current tab")}
            onClick={onClose}>
            <i>{tabs.length}</i>
          </button>
          <button type="button" className="mobile-tab-overview-close"
            aria-label={t("Close tab overview")}
            onClick={onClose}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <input className="mobile-tab-overview-search" type="search"
          placeholder={t("Search tabs")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} />
        <div className="mobile-tab-overview-grid">
          {visible.map((tab) => {
            const sessionId = tab.selection.kind === "session" ? tab.selection.id : "";
            const working = Boolean(sessionId && workingSessionIds?.has(sessionId));
            const unread = Boolean(sessionId && unreadSessionIds?.has(sessionId));
            const meta = tabKindMeta(tab);
            return <section key={tab.key}
              className={`mobile-tab-card${tab.key === activeKey ? " active" : ""}`}>
              <header>
                <b>{tab.title || t("New task")}</b>
                <button type="button" aria-label={t("Close tab")}
                  onClick={() => onCloseTab(tab)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </header>
              <button type="button" className="mobile-tab-card-body"
                onClick={() => {
                  onClose();
                  onSelectTab(tab);
                }}>
                <span className={`codicon codicon-${tabKindGlyph(tab)} mobile-tab-card-glyph`}
                  aria-hidden="true" />
                {meta && <span className="mobile-tab-card-meta">{meta}</span>}
                {working
                  ? <span className="mobile-tab-card-state is-working">{t("Working…")}</span>
                  : unread
                    ? <span className="mobile-tab-card-state is-unread">{t("Updated")}</span>
                    : null}
              </button>
            </section>;
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
