// settings-picker/settings-navigation.mjs
// Where Enter on a Settings row goes: the owning picker with a return to
// Settings (and a handoff panel where the write is slow), or the system-shell
// prompt.
export const settingsHandoffPanel = (description = 'Loading settings...') => ({
  title: 'Settings',
  description,
  help: 'Esc Close',
  indexMode: 'never',
  pickerKey: 'settings-handoff',
  loading: true,
  items: [],
});

export function createSettingsNavigation({ openers, openSettingsPicker, setSettingsPrompt }) {
  const returning = { returnTo: openSettingsPicker };
  const routes = {
    autoclear: () => openers.openAutoClearPicker(returning),
    profile: () => openers.openProfilePicker(returning),
    'output-style': () =>
      openers.openOutputStylePicker({ ...returning, handoffPanel: settingsHandoffPanel('Applying output style...') }),
    theme: () => openers.openThemePicker({ ...returning, handoffPanel: settingsHandoffPanel('Applying theme...') }),
    workflow: () =>
      openers.openWorkflowPicker({ ...returning, handoffPanel: settingsHandoffPanel('Switching workflow...') }),
    model: () =>
      openers.openModelPicker({
        ...returning,
        returnLabel: 'Settings',
        returnOnNestedCancel: true,
        onAfterSelect: openSettingsPicker,
        handoffPanel: settingsHandoffPanel('Switching model...'),
      }),
    websearch: () => openers.openWebSearchPicker({ ...returning, returnLabel: 'Settings', returnOnNestedCancel: true }),
    providers: () =>
      void openers.openProviderSetupPicker({
        ...returning,
        onCancel: openSettingsPicker,
        continueLabel: 'Back to settings',
        continueDescription: 'return to settings',
      }),
    mcp: () => openers.openMcpPicker(),
    plugins: () => openers.openPluginsPicker(),
    skills: () => openers.openSkillsPicker(),
    memory: () => openers.openMemoryCorePicker(returning),
    update: () => openers.openUpdatePicker(returning),
  };

  /** Enter on a navigation row; false when the row is not one. `own` is the
   *  Settings claim, closed before the shell prompt takes the surface. */
  const openRow = (item, { own, systemShell }) => {
    const action = item?._action;
    if (action === 'system-shell') {
      own.close();
      setSettingsPrompt({
        kind: 'system-shell',
        label: 'System shell',
        hint: 'Enter a shell command, or leave empty for automatic selection. Windows accepts powershell.exe or pwsh.',
        initialValue: systemShell.command || '',
      });
      return true;
    }
    const route = routes[action];
    if (!route) return false;
    route();
    return true;
  };

  return { openRow };
}
