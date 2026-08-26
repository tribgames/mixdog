/**
 * project-picker.mjs — the project selector / create / rename / enter cluster.
 *
 * Extracted from App.jsx behavior-preservingly. This cluster is ref/state
 * coupled (it drives the panel surface + a fan of prompt setters), so it's
 * delivered as a dependency-injection factory rather than pure functions.
 * Project registry and path operations are daemon calls on `store`; the TUI
 * retains only the OS-native folder chooser.
 */
export function createProjectPicker({
  state,
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  projectNameFromPath,
  pickFolder,
}) {
  const serviceCall = (name, ...args) => {
    const target = store?.[name];
    if (typeof target !== 'function') {
      return Promise.reject(new TypeError(`project service method ${name} is unavailable`));
    }
    return Promise.resolve(target.apply(store, args));
  };

  const buildProjectPickerState = ({
    initialEntry = false,
    projects = [],
    loading = false,
    requestId = null,
  } = {}) => {
    const currentPath = String(state.cwd || process.cwd() || '');
    const items = [];
    if (!loading) {
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
    }
    return {
      kind: 'project',
      _kind: 'project',
      _projectRequestId: requestId,
      _projectInitialPending: loading && initialEntry,
      title: 'Project',
      description: loading ? 'Loading projects from the session…' : 'Choose a project.',
      help: loading
        ? 'Waiting for the project service…'
        : initialEntry
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
          void enterProject(currentPath, { notice: !initialEntry, register: false });
          return;
        }
        const project = item?._project;
        if (project?.path) void enterProject(project.path, { notice: !initialEntry });
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
        // Esc on the list: this keypress owns the surface it clears.
        surface.claim().close();
      },
    };
  };

  // Open the manual path-entry flow. The user types a directory path; on submit
  // we register it (and offer to create it if missing). Used as a
  // fallback when no native folder dialog is available.
  const beginNewProjectManual = () => {
    const own = surface.claim();
    own.context(null);
    own.close();
    setProviderPrompt(null);
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
    // The folder dialog can stay open for minutes: the claim taken here is what
    // every branch below proves ownership with.
    const own = surface.claim();
    setProviderPrompt(null);
    own.context(null);
    closeUsagePanel();
    // Keep an overlay up (kind:'project' so the banner/height stay reserved) but
    // make it inert: no selectable items, navigation is a no-op until resolve.
    own.paint({
      kind: 'project',
      title: 'Project',
      description: 'Opening folder picker… choose a folder in the dialog window.',
      help: 'Waiting for the system folder dialog…',
      indexMode: 'never',
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: () => {},
    });
    void pickFolder({
      title: 'Select a project folder',
      initialPath: String(state.cwd || process.cwd() || ''),
    })
      .then((result) => {
        if (!own.owns()) return;
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
        void registerProject(result.path);
      })
      .catch(() => {
        if (own.owns()) beginNewProjectManual();
      });
  };

  // Register a project in the picker list without switching this session's cwd.
  const registerProject = async (rawPath) => {
    const path = String(rawPath || '').trim();
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return false;
    }
    // Post-write delegation: the project list reopen must still own the surface
    // (the add can ack long after an Esc).
    const own = surface.claim();
    try {
      const project = await serviceCall('addProject', path);
      if (project?.name) store.pushNotice(`project added: ${project.name}`, 'info');
      if (!own.owns()) return true;
      await openProjectPicker();
      return true;
    } catch (e) {
      store.pushNotice(`project add failed: ${e?.message || e}`, 'error');
      return false;
    }
  };

  // Switch the active working directory to a registered/created project path.
  const enterProject = async (rawPath, options = {}) => {
    const path = String(rawPath || '').trim();
    if (!path) {
      store.pushNotice('project path is required', 'warn');
      return false;
    }
    surface.claim().close();
    try {
      // Switch cwd first; only persist the project once the runtime accepts it,
      // so an invalid/missing path can never be written to projects.json.
      const resolved = await serviceCall('setCwd', path, {
        notice: options?.notice !== false,
        message: `Project set: ${projectNameFromPath(path)}`,
      });
      if (options?.register !== false) await serviceCall('addProject', resolved || path);
      return true;
    } catch (e) {
      store.pushNotice(`project switch failed: ${e?.message || e}`, 'error');
      return false;
    }
  };

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
    own.paint(buildProjectPickerState({
      initialEntry,
      loading: true,
      requestId,
    }));
    try {
      const projects = await serviceCall('listProjects');
      own.paint((current) => current?._projectRequestId === requestId
        ? buildProjectPickerState({
          initialEntry,
          projects: Array.isArray(projects) ? projects : [],
          requestId,
        })
        : current);
      return projects;
    } catch (error) {
      own.paint((current) => current?._projectRequestId === requestId
        ? buildProjectPickerState({ initialEntry, projects: [], requestId })
        : current);
      store.pushNotice(`project list failed: ${error?.message || error}`, 'error');
      return [];
    }
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
