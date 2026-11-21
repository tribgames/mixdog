import type { LucideIcon } from 'lucide-react';

import { t } from './i18n';

export type SidebarToolbarSection<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
};

export function SidebarSectionToolbar<Id extends string>({
  label,
  sections,
  active,
  onChange,
}: {
  label: string;
  sections: ReadonlyArray<SidebarToolbarSection<Id>>;
  active: Id;
  onChange(section: Id): void;
}) {
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: label names the toolbar container without adding a role, which would change screen-reader semantics
    <div className="sidebar-section-toolbar" aria-label={label}>
      {sections.map((item) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            key={item.id}
            className={active === item.id ? 'active' : ''}
            aria-pressed={active === item.id}
            onClick={() => onChange(item.id)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{t(item.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
