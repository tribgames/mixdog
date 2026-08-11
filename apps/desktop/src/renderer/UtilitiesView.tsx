import { FolderSearch, Sparkles, Terminal } from "lucide-react";

import { t } from "./i18n";

export function UtilitiesPane({
  active = true,
  onOpenStudio,
  onOpenTerminal,
  onOpenExplorer,
}: {
  active?: boolean;
  onOpenStudio(): void;
  onOpenTerminal(): void;
  onOpenExplorer(): void;
}) {
  const items = [
    { label: "Studio", icon: Sparkles, run: onOpenStudio },
    { label: "Terminal", icon: Terminal, run: onOpenTerminal },
    { label: "Explorer", icon: FolderSearch, run: onOpenExplorer },
  ] as const;

  return <div className="schedules-pane utilities-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? "true" : "false"}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      <div className="schedules-list utilities-list">
        {items.map(({ label, icon: Icon, run }) => (
          <button type="button" className="schedules-row utilities-row"
            key={label} onClick={run}>
            <span className="projects-row-icon" aria-hidden="true"><Icon size={16} /></span>
            <span className="schedules-row-copy"><b>{t(label)}</b></span>
          </button>
        ))}
      </div>
    </div>
  </div>;
}
