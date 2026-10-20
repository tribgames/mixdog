import { ChevronRight, FileText, Folder, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  ScmContextMenu,
  type ScmContextMenuState,
} from './ScmContextMenu';

import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';
import { InitialSurface } from './InitialSurface';
import { SidebarPanelAction } from './session-sidebar-sections';
import { projectIdentity } from './project-catalog-cache';
import { publishSidebarProjects } from './sidebar-reference-cache';
import { usePersistedListOrder } from './use-persisted-list-order';
import { displayProjectFolder, ProjectEditorDialog, type ProjectEditorDialogHandle } from './ProjectEditorDialog';

export interface ProjectListSectionProps {
  active?: boolean;
  projects: DesktopProjectSummary[];
  projectsReady?: boolean;
  selectedProjectPath: string;
  /** Opens the shared add-project dialog (hosted outside the panel). */
  onAddProject(): void;
  onRename(path: string, alias: string): void;
  onRemove(path: string): void;
  onMemoryControl?(input: Record<string, unknown>): Promise<unknown>;
}

// Project list (Projects panel → Project tab): the Schedules grammar — a
// compact list with per-row actions hosted in the session-panel area (user
// decision — no main-pane takeover). Add project opens a small popup dialog
// (Name + folder via the native chooser) portaled above the workspace. The
// hosting ProjectsPane owns the surface wrapper and the section toolbar.
export function ProjectListSection({
  active = true,
  projects,
  projectsReady = true,
  selectedProjectPath,
  onAddProject,
  onRename,
  onRemove,
  onMemoryControl,
}: ProjectListSectionProps) {
  const editorRef = useRef<ProjectEditorDialogHandle>(null);
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  // Items run after the menu closes and returns focus to the row; Remove only
  // opens the editor with its confirmation armed, never removes by itself.
  const openProjectMenu = (project: DesktopProjectSummary, label: string, point: { x: number; y: number }) =>
    setContextMenu({
      label,
      ...point,
      items: [
        {
          id: 'edit',
          label: t('Edit'),
          onSelect: () => window.setTimeout(() => editorRef.current?.open(project.path), 0),
        },
        {
          id: 'remove',
          label: t('Remove'),
          danger: true,
          separatorBefore: true,
          onSelect: () => window.setTimeout(() => editorRef.current?.open(project.path, { confirmRemove: true }), 0),
        },
      ],
    });
  // The app shell owns project add/rename/remove and refetches its catalog
  // once a mutation actually succeeded. Mirroring THAT list into the shared
  // sidebar cache is the authoritative completion boundary: a failed mutation
  // never changes the list, so it never triggers a refresh either.
  useEffect(() => {
    publishSidebarProjects(projects);
  }, [projects]);
  const projectPathsKey = JSON.stringify(projects.map((project) => project.path));
  const memoriesSupported = Boolean(onMemoryControl);
  // One shared catalog request warms every row, including empty projects.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectPathsKey is a deliberate restart trigger; the read itself goes through the editor handle.
  useEffect(() => {
    if (!active || !memoriesSupported) return;
    editorRef.current?.warm();
  }, [active, projectPathsKey, memoriesSupported]);
  // No search field (user: 프로젝트 목록은 짧다 — 서치창 제거).
  const projectOrder = usePersistedListOrder(
    'mixdog.sidebar-order.projects.v1',
    projects.map((project) => project.path)
  );
  const visible = projectOrder.orderedIds
    .map((path) => projects.find((project) => project.path === path))
    .filter((project): project is DesktopProjectSummary => Boolean(project));

  return (
    <>
      {/* The panel header names this view and hosts its action (user: 타이틀
          이 2번 나옴). */}
      {/* Plain + like every other rail panel action (user: 프로젝트도 + 통일). */}
      <SidebarPanelAction
        active={active}
        label={t('Add project')}
        icon={Plus}
        className="projects-add"
        onClick={onAddProject}
      />
      <ProjectEditorDialog
        ref={editorRef}
        active={active}
        projects={projects}
        onRename={onRename}
        onRemove={onRemove}
        onMemoryControl={onMemoryControl}
      />
      {onMemoryControl && (
        <div className="schedules-list projects-list projects-common-instructions">
          <button
            type="button"
            className="schedules-row utilities-row projects-row"
            data-tooltip={t('Used for every project.')}
            onClick={() => editorRef.current?.open(null)}
          >
            <span className="sidebar-resource-icon" aria-hidden="true">
              <FileText size={16} />
            </span>
            <span className="schedules-row-copy utilities-row-copy">
              <b>{t('Common Memory')}</b>
              <small>{t('Used for every project.')}</small>
            </span>
            <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      {!projectsReady && projects.length === 0 && <InitialSurface />}
      {(projectsReady || projects.length > 0) && visible.length > 0 && (
        <div className="schedules-list projects-list">
          {visible.map((project) => {
            const title = project.alias?.trim() || project.name?.trim() || displayProjectFolder(project.path);
            const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
            return (
              <button
                type="button"
                key={project.path}
                className={`schedules-row utilities-row projects-row${selected ? ' selected' : ''}`}
                aria-current={selected ? 'page' : undefined}
                aria-label={t('Edit {{name}}', { name: title })}
                data-tooltip={project.path}
                onClick={() => editorRef.current?.open(project.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openProjectMenu(project, title, pointerMenuPoint(event));
                }}
                onKeyDown={(event) => {
                  if (!isContextMenuKey(event)) return;
                  event.preventDefault();
                  openProjectMenu(project, title, elementMenuPoint(event.currentTarget));
                }}
                {...projectOrder.getReorderProps(project.path)}
              >
                <span className="sidebar-resource-icon" aria-hidden="true">
                  <Folder size={16} />
                </span>
                <span className="schedules-row-copy utilities-row-copy projects-row-label">
                  <b>{title}</b>
                  <small>{project.path}</small>
                </span>
                <ChevronRight className="utilities-row-chevron" size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      <ScmContextMenu state={contextMenu} onClose={closeContextMenu} />
      {(projectsReady || projects.length > 0) && visible.length === 0 && (
        <div className="utility-dock-empty">
          <p>{t('No projects.')}</p>
        </div>
      )}
    </>
  );
}
