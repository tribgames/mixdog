import { ChevronRight, Files, Globe, Sparkles, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "./i18n";
import { usePersistedListOrder } from "./use-persisted-list-order";

// Browser Use ships install-first: its Utilities entry appears only once the
// feature is installed, matching the session tool surface. The settings panel
// announces marker changes, so an install lands here live without polling.
function useBrowserFeatureInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void window.mixdogDesktop?.readSettings?.().then((settings) => {
        if (live) setInstalled(settings?.browserInstalled !== false);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener("mixdog:built-in-features-changed", refresh);
    return () => {
      live = false;
      window.removeEventListener("mixdog:built-in-features-changed", refresh);
    };
  }, []);
  return installed;
}

export function UtilitiesPane({
  active = true,
  onOpenBrowser,
  onOpenStudio,
  onOpenTerminal,
  onOpenExplorer,
}: {
  active?: boolean;
  onOpenBrowser(): void;
  onOpenStudio(): void;
  onOpenTerminal(): void;
  onOpenExplorer(): void;
}) {
  const items = [
    {
      label: "Browser",
      description: "Browse the web in a tab agents can drive.",
      icon: Globe,
      run: onOpenBrowser,
    },
    {
      label: "Studio",
      description: "Generate images and videos with AI.",
      icon: Sparkles,
      run: onOpenStudio,
    },
    {
      label: "Terminal",
      description: "Open a shell in the current project.",
      icon: SquareTerminal,
      run: onOpenTerminal,
    },
    {
      label: "Explorer",
      description: "Browse and edit project files.",
      icon: Files,
      run: onOpenExplorer,
    },
  ] as const;
  const order = usePersistedListOrder(
    "mixdog.sidebar-order.utilities.v1",
    items.map((item) => item.label),
  );
  const browserInstalled = useBrowserFeatureInstalled();
  const orderedItems = order.orderedIds
    .map((id) => items.find((item) => item.label === id))
    .filter((item): item is (typeof items)[number] => Boolean(item))
    .filter((item) => item.label !== "Browser" || browserInstalled);

  return <div className="schedules-pane utilities-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? "true" : "false"}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      <div className="schedules-list utilities-list">
        {orderedItems.map(({ label, description, icon: Icon, run }) => (
          <button type="button" className="schedules-row utilities-row"
            key={label} onClick={run} {...order.getReorderProps(label)}>
            <Icon className="utilities-row-icon" size={16} aria-hidden="true" />
            <span className="schedules-row-copy utilities-row-copy">
              <b>{t(label)}</b>
              <small>{t(description)}</small>
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  </div>;
}
