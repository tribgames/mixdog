import { Folder, Layers3 } from 'lucide-react';

import { t } from './i18n';
import { ProjectListSection, type ProjectListSectionProps } from './ProjectListSection';
import type { ProjectsSection } from './project-sections';
import { SidebarSectionToolbar, type SidebarToolbarSection } from './sidebar-section-toolbar';
import { WorkflowsPane } from './WorkflowsView';
import { useSurfaceNavigationReset } from './surface-activity';

const SECTIONS: ReadonlyArray<SidebarToolbarSection<ProjectsSection>> = [
  { id: 'projects', label: 'Project', icon: Folder },
  { id: 'workflows', label: 'Workflow', icon: Layers3 },
];

// Projects panel (rail → Projects): ONE rail destination hosting two sections
// behind the Extensions panel's section toolbar (user: 익스텐션처럼 하위 전환
// 버튼). Project lists the registered folders with their instructions and
// memories; Workflow carries the workflow packs, default agents, and agent
// definitions that used to own their own rail icon. Only the visible section
// mounts, so the header + follows the Project tab and a half-open editor
// closes on switch, exactly like Extensions.
export function ProjectsPane({
  active = true,
  section = 'projects',
  onSectionChange,
  ...list
}: ProjectListSectionProps & {
  /** The app shell owns the section like it owns the Extensions one, so
   *  /workflow and /websearch can land on the Workflow tab. Standalone hosts
   *  and unit tests render the Project tab. */
  section?: ProjectsSection;
  onSectionChange?(section: ProjectsSection): void;
}) {
  useSurfaceNavigationReset(active, () => onSectionChange?.('projects'));
  return <div className="schedules-pane projects-pane stable-surface-preserved stable-takeover-surface"
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}>
    <div className="schedules-page">
      <SidebarSectionToolbar label={t('Projects')} sections={SECTIONS}
        active={section} onChange={(next) => onSectionChange?.(next)} />
      {section === 'workflows'
        ? <WorkflowsPane active={active} />
        : <ProjectListSection active={active} {...list} />}
    </div>
  </div>;
}
