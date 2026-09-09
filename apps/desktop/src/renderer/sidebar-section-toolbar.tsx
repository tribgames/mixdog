import type { LucideIcon } from 'lucide-react';

import { t } from './i18n';

export type SidebarToolbarSection<Id extends string> = {
  id: Id;
  label: string;
  icon: LucideIcon;
};

// Rail panels that host more than one resource kind (Extensions: Plugin |
// Skill, Projects: Project | Workflow) switch between them with this one
// toolbar so every such panel reads as the same product instead of a
// hand-rolled tab strip (user: 익스텐션창이 다른 UI랑 너무 동떨어져있다). The
// panel header's + belongs to the VISIBLE section.
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
  return <div className="sidebar-section-toolbar" aria-label={label}>
    {sections.map((item) => {
      const Icon = item.icon;
      return <button type="button" key={item.id}
        className={active === item.id ? 'active' : ''}
        aria-pressed={active === item.id}
        onClick={() => onChange(item.id)}>
        <Icon size={14} aria-hidden="true" />
        <span>{t(item.label)}</span>
      </button>;
    })}
  </div>;
}
