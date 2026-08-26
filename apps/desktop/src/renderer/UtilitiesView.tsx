import { ChevronRight } from "lucide-react";

import { t } from "./i18n";
import { usePersistedListOrder } from "./use-persisted-list-order";

export function UtilitiesPane({
  active = true,
  onOpenStudio,
  onOpenBrowser,
  onOpenTerminal,
  onOpenExplorer,
}: {
  active?: boolean;
  onOpenStudio(): void;
  onOpenBrowser(): void;
  onOpenTerminal(): void;
  onOpenExplorer(): void;
}) {
  const items = [
    {
      label: "Studio",
      description: "Generate images and videos with AI.",
      run: onOpenStudio,
    },
    {
      label: "Terminal",
      description: "Open a shell in the current project.",
      run: onOpenTerminal,
    },
    {
      label: "Explorer",
      description: "Browse and edit project files.",
      run: onOpenExplorer,
    },
    {
      label: "Browser",
      description: "Browse the web in a tab agents can drive.",
      run: onOpenBrowser,
    },
  ] as const;
  const order = usePersistedListOrder(
    "mixdog.sidebar-order.utilities.v1",
    items.map((item) => item.label),
  );
  const orderedItems = order.orderedIds
    .map((id) => items.find((item) => item.label === id))
    .filter((item): item is (typeof items)[number] => Boolean(item));

  return <div className="schedules-pane utilities-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? "true" : "false"}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      <div className="schedules-list utilities-list">
        {orderedItems.map(({ label, description, run }) => (
          <button type="button" className="schedules-row utilities-row"
            key={label} onClick={run} {...order.getReorderProps(label)}>
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
