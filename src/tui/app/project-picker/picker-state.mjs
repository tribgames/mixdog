/**
 * project-picker/picker-state.mjs — the picker panel record: registered
 * projects, the trailing current-path shortcut, and the row/key handlers that
 * route into the late-bound picker `actions`.
 */
function projectPickerHelp(loading, initialEntry) {
  if (loading) return 'Waiting for the project service…';
  return initialEntry
    ? '↑/↓ Select · Enter Open · c Create · r Rename'
    : '↑/↓ Select · Enter Open · c Create · r Rename · Esc Back';
}

export function buildProjectPickerState(
  { state, surface },
  actions,
  { initialEntry = false, projects = [], loading = false, requestId = null } = {}
) {
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
    help: projectPickerHelp(loading, initialEntry),
    indexMode: 'always',
    labelWidth: 18,
    metaWidth: 40,
    items,
    onSelect: (_value, item) => {
      if (item?._action === 'current') {
        void actions.enterProject(currentPath, { notice: !initialEntry, register: false });
        return;
      }
      const project = item?._project;
      if (project?.path) void actions.enterProject(project.path, { notice: !initialEntry });
    },
    onKey: (input, _key, item) => {
      if (input === 'c' || input === 'C') {
        actions.beginNewProject();
        return;
      }
      // 'r' renames the highlighted registered project (not the current-dir
      // shortcut).
      if ((input === 'r' || input === 'R') && item?._project?.path) {
        actions.beginRenameProject(item._project);
      }
    },
    onCancel: () => {
      // Esc on the list: this keypress owns the surface it clears.
      surface.claim().close();
    },
  };
}
