// Project navigation actions, extracted from App.tsx: entering a project,
// starting a task inside one, and the registry edits the Projects page makes.
// A Projects-panel row no longer opens anything (user: 클릭 없애 그냥), so the
// NEW TASK draft staging that used to live here is gone.
// Plain factory (no hooks): the actions are rebuilt each render exactly as the
// inline closures were, so they always see current props/state.
import type { DesktopProjectSummary, SessionSnapshot } from "../shared/contract";
import type { NavigationSelection } from "./navigation";
import type { Project, Snapshot } from "./desktop-types";
import { displayProject } from "./text-format";

export interface ProjectActionDeps {
  projects: DesktopProjectSummary[];
  /** Runs an action with the shared error/toast plumbing. */
  invoke: (action: () => unknown) => Promise<void>;
  applySnapshot: (snapshot: SessionSnapshot) => void;
  activateSelection: (selection: NavigationSelection, title: string, replaceKey?: string) => void;
  /** Re-reads the engine's real state after a failed navigation. */
  synchronizeActualHost: () => Promise<void>;
  closeSidebarForNavigation: () => void;
  refreshProjects: () => Promise<DesktopProjectSummary[]>;
  refreshSessionsBestEffort: (selectCurrent?: boolean) => void;
  beginNavigation: () => void;
}

export function createProjectActions(deps: ProjectActionDeps) {
  const {
    projects, invoke, applySnapshot, activateSelection, synchronizeActualHost,
    closeSidebarForNavigation, refreshProjects, refreshSessionsBestEffort,
    beginNavigation,
  } = deps;

  // The engine may canonicalize the requested folder (symlinks, casing); the
  // selection must follow the path it actually entered.
  const canonicalProject = (value: SessionSnapshot, fallback: string) => {
    const state = value && typeof value === "object" ? value as Snapshot : null;
    return String(state?.currentProject || state?.project || fallback);
  };

  const projectTitle = (projectPath: string) => {
    const summary = projects.find((item) => item.path === projectPath);
    return summary?.alias?.trim() || summary?.name?.trim()
      || displayProject(projectPath).name || "Project";
  };

  const enterProject = (next: SessionSnapshot, requested: Project) => {
    applySnapshot(next);
    const projectPath = canonicalProject(next, requested);
    activateSelection({ kind: "project", path: projectPath }, projectTitle(projectPath));
  };

  // A failed navigation leaves the engine wherever it actually is; resynchronize
  // instead of keeping the optimistic selection.
  const navigate = (action: () => Promise<void>) => invoke(async () => {
    try {
      await action();
    } catch (reason) {
      await synchronizeActualHost();
      throw reason;
    }
  });

  return {
    startProject(project: Project) {
      closeSidebarForNavigation();
      beginNavigation();
      void navigate(async () => {
        enterProject(await window.mixdogDesktop?.startProject(project), project);
        refreshSessionsBestEffort();
      });
    },
    startProjectTask(project: Project) {
      closeSidebarForNavigation();
      beginNavigation();
      void navigate(async () => {
        enterProject(await window.mixdogDesktop.startProjectTask(project), project);
        await refreshProjects();
        refreshSessionsBestEffort();
      });
    },
    openProjectInExplorer(project: Project) {
      return invoke(() => window.mixdogDesktop.openProjectInExplorer(project));
    },
    renameProject(project: Project, alias: string) {
      return invoke(async () => {
        await window.mixdogDesktop.renameProject(project, alias);
        await refreshProjects();
      });
    },
    removeProject(project: Project) {
      return invoke(async () => {
        await window.mixdogDesktop.removeProject(project);
        await refreshProjects();
      });
    },
  };
}
