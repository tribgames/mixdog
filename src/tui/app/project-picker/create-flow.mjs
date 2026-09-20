/**
 * project-picker/create-flow.mjs — "create project": the OS-native folder
 * dialog with the manual path-entry fallback. `actions` is the late-bound
 * picker surface (openProjectPicker, registerProject).
 */
export function createProjectCreateFlow(
  { state, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel, pickFolder },
  actions
) {
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
          actions.openProjectPicker();
          return;
        }
        void actions.registerProject(result.path);
      })
      .catch(() => {
        if (own.owns()) beginNewProjectManual();
      });
  };

  return { beginNewProjectManual, beginNewProject };
}
