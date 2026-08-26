import { Blocks, Plus, Plug, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "./i18n";
import { SidebarPanelAction } from "./session-sidebar";
import { CapabilitySettings } from "./settings/CapabilitySettings";
import "./settings/settings.css";
import "./desktop/31-extensions.css";

export type ExtensionsSection = "skills" | "mcp" | "plugins";

const SECTIONS: ReadonlyArray<{
  id: ExtensionsSection;
  label: string;
  icon: typeof Plus;
}> = [
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "plugins", label: "Plugins", icon: Blocks },
];

const CREATE_LABEL = {
  skills: "Add skill",
  mcp: "Add MCP server",
  plugins: "Install plugin",
} as const satisfies Record<ExtensionsSection, string>;

export function ExtensionsPane({
  active,
  section,
  onSectionChange,
}: {
  active: boolean;
  section: ExtensionsSection;
  onSectionChange(section: ExtensionsSection): void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const api = window.mixdogDesktop ?? {};
  // The header's + belongs to the VISIBLE section: switching tabs drops a
  // half-filled form instead of carrying it into a different resource kind.
  useEffect(() => { setCreateOpen(false); }, [section]);

  // Extensions is a RAIL destination, so it renders the page grammar its
  // siblings (Schedules, Webhooks) already share: surface → page → filters →
  // list, with the title and primary actions in the panel header and detail
  // views opening as popup dialogs. The pane used to hand-roll a tab
  // strip and a second toolbar band, which is what made it read as a different
  // product (user: 익스텐션창이 다른 UI랑 너무 동떨어져있다).
  return <div className="extensions-pane schedules-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? "true" : "false"}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      {/* Title and primary actions live in the sidebar panel header. */}
      <SidebarPanelAction active={active} label={t(CREATE_LABEL[section])} icon={Plus}
        onClick={() => setCreateOpen((open) => !open)} />
      <div className="extensions-section-toolbar" aria-label={t("Extension type")}>
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          return <button type="button" key={item.id}
            className={section === item.id ? "active" : ""}
            aria-pressed={section === item.id}
            onClick={() => onSectionChange(item.id)}>
            <Icon size={14} aria-hidden="true" />
            <span>{t(item.label)}</span>
          </button>;
        })}
      </div>
      <CapabilitySettings api={api} category={section}
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen} />
    </div>
  </div>;
}
