/**
 * project-picker.mjs — the project selector / create / rename / enter cluster.
 *
 * Extracted from App.jsx behavior-preservingly. This cluster is ref/state
 * coupled (it drives setPicker + a fan of prompt setters), so it's delivered as
 * a dependency-injection factory rather than pure functions: App calls
 * createProjectPicker({...}) once and destructures the returned builders. Every
 * function body is the original App logic, verbatim, with closure identifiers
 * (state, store, setPicker, the prompt setters, and the projects.mjs helpers)
 * threaded in through the factory argument.
 */
export function createProjectPicker({
  state,
  store,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  closeUsagePanel,
  listProjects,
  addProject,
  touchProjectSelected,
  resolveProjectPath,
  projectNameFromPath,
  pickFolder,
}) {
  const buildProjectPickerState = ({ initialEntry = false } = {}) => {
    let projects = [];
    try {
      projects = listProjects() || [];
    } catch {
      projects = [];
    }
    const currentPath = String(state.cwd || process.cwd() || '');
    const items = [];
    // Registered projects (store order via listProjects).
    for (const project of projects) {
      if (!project?.path) continue;
      items.push({
        value: project.path,
        label: project.name || project.path,
        meta: project.path,
        _project: project,
      });
    }
    // Last row: implicit current-directory shortcut (not persisted).
    items.push({
      value: '__use_current__',
      label: 'Current Path',
      meta: currentPath,
      _action: 'current',
    });
    return {
      kind: 'project',
      title: 'Project',
      description: 'Choose a project.',
      help: initialEntry
        ? '↑/↓ Select · Enter Open · c Create · r Rename'
        : '↑/↓ Select · Enter Open · c Create · r Rename · Esc Back',
      indexMode: 'always',
      labelWidth: 18,
      metaWidth: 40,
      items,
      onSelect: (_value, item) => {
        if (item?._action === 'new') {
          beginNewProject();
          return;
        }
        if (item?._action === 'current') {
          setPicker(null);
          try {
            store.setCwd?.(currentPath, {
              notice: !initialEntry,
              message: `Project set: ${projectNameFromPath(currentPath)}`,
            });
          } catch (e) {
            store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
          }
          return;
        }
        setPicker(null);
        const project = item?._project;
        if (project?.path) enterProject(project.path, { notice: !initialEntry });
      },
      onKey: (input, _key, item) => {
        if (input === 'c' || input === 'C') {
          beginNewProject();
          return;
        }
        // 'r' renames the highlighted registered project (not the current-dir
        // shortcut or the create row).
        if ((input === 'r' || input === 'R') && item?._project?.path) {
          beginRenameProject(item._project);
        }
      },
      onCancel: () => {
        setPicker(null);
      },
    };
  };

  // Open the manual path-entry flow. The user types a directory path; on submit
  // we register it (and offer to create it if missing). Used as a
  // fallback when no native folder dialog is available.
  const beginNewProjectManual = () => {
    setPicker(null);
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setSettingsPrompt({
      kind: 'project-new',
      label: 'New project · Path',
      hint: 'Type a directory path. The folder name becomes the project name.',
    });
  };

  // Begin "create project": open the OS-native folder picker. The project picker
  // stays mounted (swapped to a non-interactive "Opening folder picker…" panel)
  // while the native dialog is open, so the welcome banner/layout stay put and
  // the prompt remains disabled (input is gated on `!!picker`). On a chosen
  // folder we register; on cancel we return to the project picker;
  // when no dialog tool exists we fall back to manual path typing.
  const beginNewProject = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    // Keep an overlay up (kind:'project' so the banner/height stay reserved) but
    // make it inert: no selectable items, navigation is a no-op until resolve.
    setPicker({
      kind: 'project',
      title: 'Project',
      description: 'Opening folder picker… choose a folder in the dialog window.',
      help: 'Waiting for the system folder dialog…',
      indexMode: 'never',
      items: [],
      onSelect: () => {},
      onCancel: () => {},
    });
    void pickFolder({
      title: 'Select a project folder',
      initialPath: String(state.cwd || process.cwd() || ''),
    })
      .then((result) => {
        if (!result || result.available === false) {
          // No native dialog on this system → manual typing.
          beginNewProjectManual();
          return;
        }
        if (!result.path) {
          // User cancelled the dialog → back to the project list.
          openProjectPicker();
          return;
        }
        registerProject(result.path);
      })
      .catch(() => {
        beginNewProjectManual();
      });
  };

  // Register a project in the picker list without switching this session's cwd.
  const registerProject = (rawPath) => {
    const path = resolveProjectPath(rawPath);
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return;
    }
    try {
      const project = addProject(path);
      if (project?.name) store.pushNotice(`project added: ${project.name}`, 'info');
      openProjectPicker();
    } catch (e) {
      store.pushNotice(`project add failed: ${e?.message || e}`, 'error');
    }
  };

  // Switch the active working directory to a registered/created project path.
  const enterProject = (rawPath, options = {}) => {
    const path = resolveProjectPath(rawPath);
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return;
    }
    try {
      // Switch cwd first; only persist the project once the runtime accepts it,
      // so an invalid/missing path can never be written to projects.json.
      store.setCwd?.(path, {
        notice: options?.notice !== false,
        message: `Project set: ${projectNameFromPath(path)}`,
      });
      addProject(path);
      touchProjectSelected(path);
    } catch (e) {
      store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
    }
  };

  // Begin renaming a registered project's display name. Opens a text prompt
  // seeded with the current name; submitting persists via renameProject and
  // returns to the project picker. The path is never changed.
  const beginRenameProject = (project) => {
    if (!project?.path) return;
    setPicker(null);
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setSettingsPrompt({
      kind: 'project-rename',
      label: 'Rename project',
      hint: 'Set a display name. Leave blank to reset to the folder name.',
      projectPath: project.path,
      initialValue: project.name || '',
    });
  };

  // Open the project selector, styled like the Model picker: numbered rows with
  // a Name column + Path column. The list always opens (even when empty) and
  // lists registered projects first, then a trailing "Current Path" shortcut.
  // Creating a new project is available via the picker-level c shortcut.
  const openProjectPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    setPicker(buildProjectPickerState());
  };

  return {
    buildProjectPickerState,
    beginNewProjectManual,
    beginNewProject,
    registerProject,
    enterProject,
    beginRenameProject,
    openProjectPicker,
  };
}
