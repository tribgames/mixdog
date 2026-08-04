// Project navigation actions, extracted from App.tsx: entering a project,
// starting a task inside one, and the registry edits the Projects page makes.
// Plain factory (no hooks): the actions are rebuilt each render exactly as the
// inline closures were, so they always see current props/state.
import type { DesktopProjectSummary, EngineSnapshot } from "../shared/contract";
import type { NavigationSelection } from "./navigation";
import type { Project, Snapshot } from "./desktop-types";
import { displayProject } from "./text-format";

export interface ProjectActionDeps {
  projects: DesktopProjectSummary[];
  /** Runs an action with the shared error/toast plumbing. */
  invoke: (action: () => unknown) => Promise<void>;
  applySnapshot: (snapshot: EngineSnapshot) => void;
  activateSelection: (selection: NavigationSelection, title: string, replaceKey?: string) => void;
  /** Re-reads the engine's real state after a failed navigation. */
  synchronizeActualHost: () => Promise<void>;
  closeSidebarForNavigation: () => void;
  refreshProjects: () => Promise<unknown>;
  refreshSessionsBestEffort: (selectCurrent?: boolean) => void;
  beginNavigation: () => void;
  setNewTaskActive: (active: boolean) => void;
  markNewTaskReady: (ready: boolean) => void;
  stageNewTaskProject: (project: Project) => void;
  focusComposer: () => void;
}

export function createProjectActions(deps: ProjectActionDeps) {
  const {
    projects, invoke, applySnapshot, activateSelection, synchronizeActualHost,
    closeSidebarForNavigation, refreshProjects, refreshSessionsBestEffort,
    beginNavigation, setNewTaskActive, markNewTaskReady, stageNewTaskProject,
    focusComposer,
  } = deps;

  // The engine may canonicalize the requested folder (symlinks, casing); the
  // selection must follow the path it actually entered.
  const canonicalProject = (value: EngineSnapshot, fallback: string) => {
    const state = value && typeof value === "object" ? value as Snapshot : null;
    return String(state?.currentProject || state?.project || fallback);
  };

  const projectTitle = (projectPath: string) => {
    const summary = projects.find((item) => item.path === projectPath);
    return summary?.alias?.trim() || summary?.name?.trim()
      || displayProject(projectPath).name || "Project";
  };

  const enterProject = (next: EngineSnapshot, requested: Project) => {
    applySnapshot(next);
    const projectPath = canonicalProject(next, requested);
    activateSelection({ kind: "project", path: projectPath }, projectTitle(projectPath));
    setNewTaskActive(false);
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

  /** Open a project as a fresh draft task rather than entering its workspace. */
  const activateNewProjectContext = (project: Project) => {
    beginNavigation();
    stageNewTaskProject(project);
    activateSelection({ kind: "new" }, "New task");
    markNewTaskReady(false);
    setNewTaskActive(false);
    focusComposer();
  };

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
    selectNewTaskProject(project: Project) {
      closeSidebarForNavigation();
      activateNewProjectContext(project);
    },
    chooseNewTaskProject() {
      void invoke(async () => {
        const selected = await window.mixdogDesktop.chooseProject();
        if (!selected) return;
        activateNewProjectContext(selected);
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
