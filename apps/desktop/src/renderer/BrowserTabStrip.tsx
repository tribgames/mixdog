import { useEffect, useRef, useState } from "react";
import { ExternalLink, Globe, LoaderCircle, Maximize2, Minimize2, Plus, X } from "lucide-react";
import type { DesktopBrowserTab } from "../shared/contract";
import { t } from "./i18n";

export function BrowserTabStrip({
  tabs, onSelect, onCreate, onClose, expanded = false, onToggleExpanded,
}: {
  tabs: readonly DesktopBrowserTab[];
  onSelect(id: string): Promise<void>;
  onCreate(): Promise<void>;
  onClose(id: string): Promise<void>;
  expanded?: boolean;
  onToggleExpanded?(): void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const activeId = tabs.find(tab => tab.active)?.id;
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try { await action(); } catch { /* The page client presents action failures. */ }
    finally { pending.current = false; setBusy(false); }
  };

  return <div className="browser-tab-toolbar">
    <div ref={strip} className="browser-tab-list" role="tablist" aria-label={t("Browser tabs")}
      aria-busy={busy} onKeyDown={event => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if ((!offset && event.key !== "Home" && event.key !== "End") || !tabs.length) return;
        event.preventDefault();
        const index = tabs.findIndex(tab => tab.active);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
          : (index + offset + tabs.length) % tabs.length;
        void run(() => onSelect(tabs[next].id));
        strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
      {tabs.map(tab => {
        const title = tab.title || (tab.url && tab.url !== "about:blank" ? tab.url : t("New tab"));
        return <div key={tab.id} className={`browser-tab${tab.active ? " is-active" : ""}`}
          onAuxClick={event => {
            if (event.button !== 1) return;
            event.preventDefault();
            void run(() => onClose(tab.id));
          }}>
          <button type="button" role="tab" data-page-id={tab.id}
            aria-selected={tab.active} tabIndex={tab.active ? 0 : -1}
            disabled={busy} className="browser-tab-select" title={`${title}\n${tab.url}`}
            onClick={() => void run(() => onSelect(tab.id))}>
            {tab.loading ? <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />
              : tab.kind === "popup" ? <ExternalLink size={13} aria-hidden="true" />
                : <Globe size={13} aria-hidden="true" />}
            <span>{title}</span>
            {tab.kind === "popup" && <small>{t("Popup")}</small>}
          </button>
          <button type="button" className="browser-tab-close" disabled={busy}
            aria-label={`${t("Close tab")}: ${title}`} data-tooltip={t("Close tab")}
            onClick={() => void run(() => onClose(tab.id))}>
            <X size={12} aria-hidden="true" />
          </button>
        </div>;
      })}
    </div>
    <button type="button" className="browser-pane-nav-button" disabled={busy || !tabs.length}
      aria-label={t("New tab")} data-tooltip={t("New tab")} onClick={() => void run(onCreate)}>
      <Plus size={15} />
    </button>
    {onToggleExpanded && <button type="button" className="browser-pane-nav-button"
      aria-label={expanded ? t("Restore browser") : t("Expand browser")}
      data-tooltip={expanded ? t("Restore browser") : t("Expand browser")}
      onClick={onToggleExpanded}>
      {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    </button>}
  </div>;
}
