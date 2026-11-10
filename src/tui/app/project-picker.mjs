/**
 * project-picker.mjs — the project selector / create / rename / enter cluster.
 *
 * This cluster is ref/state
 * coupled (it drives the panel surface + a fan of prompt setters), so it's
 * delivered as a dependency-injection factory rather than pure functions.
 * Project registry and path operations are daemon calls on `store`; the TUI
 * retains only the OS-native folder chooser.
 *
 * project-picker/: picker-state (panel record), create-flow (folder dialog +
 * manual fallback), project-service (register / enter through the daemon).
 * The pieces call each other through the late-bound `actions` record.
 */
import { buildProjectPickerState } from './project-picker/picker-state.mjs';
import { createProjectCreateFlow } from './project-picker/create-flow.mjs';
import { createProjectService } from './project-picker/project-service.mjs';

export function createProjectPicker(deps) {
  const { store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel } = deps;
  const actions = {};
  const service = createProjectService(deps, actions);
  const createFlow = createProjectCreateFlow(deps, actions);

  // Begin renaming a registered project's display name. Opens a text prompt
  // seeded with the current name; submitting persists via renameProject and
  // returns to the project picker. The path is never changed.
  const beginRenameProject = (project) => {
    if (!project?.path) return;
    const own = surface.claim();
    own.context(null);
    own.close();
    setProviderPrompt(null);
    closeUsagePanel();
    setSettingsPrompt({
      kind: 'project-rename',
      label: 'Rename project',
      hint: 'Set a display name. Leave blank to reset to the folder name.',
      projectPath: project.path,
      initialValue: project.name || '',
    });
  };

  const pickerState = (options) => buildProjectPickerState(deps, actions, options);

  // Open the project selector, styled like the Model picker: numbered rows with
  // a Name column + Path column. The list always opens (even when empty) and
  // lists registered projects first, then a trailing "Current Path" shortcut.
  // Creating a new project is available via the picker-level c shortcut.
  const openProjectPicker = async ({ initialEntry = false } = {}) => {
    const own = surface.claim();
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    const requestId = Symbol('project-picker-request');
    own.paint(pickerState({ initialEntry, loading: true, requestId }));
    const paintList = (projects) =>
      own.paint((current) =>
        current?._projectRequestId === requestId ? pickerState({ initialEntry, projects, requestId }) : current
      );
    try {
      const projects = await service.call('listProjects');
      paintList(Array.isArray(projects) ? projects : []);
      return projects;
    } catch (error) {
      paintList([]);
      store.pushNotice(`project list failed: ${error?.message || error}`, 'error');
      return [];
    }
  };

  Object.assign(actions, {
    beginNewProjectManual: createFlow.beginNewProjectManual,
    beginNewProject: createFlow.beginNewProject,
    registerProject: service.registerProject,
    enterProject: service.enterProject,
    beginRenameProject,
    openProjectPicker,
  });

  return { buildProjectPickerState: pickerState, ...actions };
}
