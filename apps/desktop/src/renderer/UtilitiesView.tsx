import { ChevronRight, Sparkles, SquareTerminal } from "lucide-react";

import { t } from "./i18n";
import { usePersistedListOrder } from "./use-persisted-list-order";

// Browser left this list for its own rail launcher (user: 브라우저 — 유틸리티
// 에서 빠져서), taking the install-marker gate with it.
export function UtilitiesPane({
  active = true,
  onOpenStudio,
  onOpenTerminal,
}: {
  active?: boolean;
  onOpenStudio(): void;
  onOpenTerminal(): void;
}) {
  const items = [
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
