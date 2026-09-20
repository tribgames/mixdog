// slash-dispatch/panel-commands.mjs
// Slash commands that open a management panel (project, MCP, skills, plugins,
// providers, memory, auto-clear, usage, context, settings, profile, update) or
// answer with a notice where the surface is desktop-only.
const panelCommand = (command, title, open) => (ctx) => {
  ctx.openSlashPanel(command, title, () => open(ctx.deps));
  return true;
};

const desktopOnlyNotice = (ctx) => {
  // Management surface is desktop-only (user decision): hidden from the
  // palette, and a typed command answers instead of opening a picker.
  ctx.store.pushNotice('Schedules and webhooks are managed in the Mixdog desktop app', 'info');
  return true;
};

const openSettings = panelCommand('settings', 'Settings', (deps) => deps.openSettingsPicker());

export const panelCommands = {
  project(ctx, arg) {
    const target = arg.trim();
    if (target) {
      ctx.deps.enterProject(target);
      return true;
    }
    ctx.openSlashPanel('project', 'Projects', () => ctx.deps.openProjectPicker());
    return true;
  },
  mcp: panelCommand('mcp', 'MCP Servers', (deps) => deps.openMcpPicker()),
  skills: panelCommand('skills', 'Skills', (deps) => deps.openSkillsPicker()),
  plugins: panelCommand('plugins', 'Plugins', (deps) => deps.openPluginsPicker()),
  providers: panelCommand('providers', 'Providers', (deps) => deps.openProviderSetupPicker()),
  schedules: desktopOnlyNotice,
  webhooks: desktopOnlyNotice,

  memory(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    if (!arg.trim()) {
      openSlashPanel('memory', 'Memory', () => deps.openMemoryCorePicker({ returnTo: null }));
      return true;
    }
    void store
      .memoryControl?.(deps.parseMemoryCommand(arg))
      .catch((e) => store.pushNotice(`memory failed: ${e?.message || e}`, 'error'));
    return true;
  },

  autoclear(ctx, arg) {
    const { store, openSlashPanel, deps } = ctx;
    const value = arg.trim().toLowerCase();
    if (!value) {
      openSlashPanel('autoclear', 'Auto-clear', () => deps.openAutoClearPicker());
      return true;
    }
    // Promise-shaped on a daemon-backed store, so the verdict is reported
    // when the call settles instead of read off the (always truthy) call.
    const autoClearCall = () => {
      if (value === 'status') return store.getAutoClear?.();
      if (['on', 'enable', 'enabled'].includes(value)) return store.setAutoClear?.({ enabled: true });
      if (['off', 'disable', 'disabled'].includes(value)) return store.setAutoClear?.({ enabled: false });
      return store.setAutoClear?.({ duration: value });
    };
    void Promise.resolve(autoClearCall())
      .then((next) => {
        if (!next) {
          store.pushNotice('autoclear unavailable', 'warn');
          return;
        }
        store.pushNotice(`autoclear ${next.enabled ? 'on' : 'off'} · idle ${deps.formatDuration(next.idleMs)}`, 'info');
      })
      .catch((e) => store.pushNotice(`autoclear failed: ${e?.message || e}`, 'error'));
    return true;
  },

  usage(ctx, arg) {
    ctx.openSlashPanel('usage', 'Provider Quotas', () => ctx.deps.openUsagePanel(arg));
    return true;
  },
  context: panelCommand('context', 'Context Usage', (deps) => deps.openContextPicker()),
  settings: openSettings,
  config: openSettings,
  profile: panelCommand('profile', 'Profile', (deps) => deps.openProfilePicker()),
  update: panelCommand('update', 'Update', (deps) => deps.openUpdatePicker()),
};
