// settings-api.mjs — pure settings delegate methods extracted from the main
// runtime API object in mixdog-session-runtime.mjs. These are the small
// config/settings members with NO heavy closure deps beyond the injected
// helpers; the returned object is SPREAD into the facade's API object so the
// external surface stays byte-identical. Methods that reference `this.*`
// resolve against the spread target, so cross-member calls (e.g.
// setProfile -> this.getProfile) keep working when spread into the facade.

import {
  INSTALLABLE_BUILTIN_IDS,
  builtinInstalled,
  setBuiltinInstalledInConfig,
} from './builtin-features.mjs';

export function createSettingsApi({
  // config accessors / mutable state
  getConfig,
  getRoute,
  getSession,
  // config-lifecycle
  adoptConfig,
  saveConfigAndAdopt,
  scheduleChannelProviderSave,
  scheduleSkillsSave,
  // normalizers / helpers
  cfgMod,
  hasOwn,
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  normalizeCompactionConfig,
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  autoClearProviderDefaults,
  setConfiguredShell,
  setRecapEnabledInConfig,
  setMemoryToolsEnabledInConfig,
  setModuleEnabledInConfig,
  // Built-in install adapter: feature-specific preparation (model
  // pre-download, component verification) before the installed marker lands.
  prepareBuiltinFeature,
  summarizeWorkflowRoutes,
  parseDurationMs,
  formatDurationMs,
  localPackageVersion,
  // state getters / feature flags
  recapEnabledFn,
  memoryToolsEnabledFn,
  gitToolsEnabledFn,
  officeToolsEnabledFn,
  webSearchEnabled,
  channelsEnabled,
  autoUpdateEnabled,
  getUpdateCheckState,
  getUpdateProcessState,
  // side-effect callbacks
  invalidateContextStatusCache,
  invalidatePreSessionToolSurface,
  refreshEmptySessionToolPolicy,
  scheduleChannelStart,
  channels,
  clearChannelStartTimer,
  checkForUpdateInternal,
  runUpdateNowInternal,
  reloadChannelsSoon,
  ONBOARDING_VERSION,
}) {
  return {
    getOnboardingStatus() {
      const nextConfig = getConfig();
      return {
        completed: nextConfig?.onboarding?.completed === true,
        version: nextConfig?.onboarding?.version || 0,
        default: nextConfig?.default || null,
        workflowRoutes: summarizeWorkflowRoutes(nextConfig),
      };
    },
    // Mark onboarding as done WITHOUT touching routes/agents/provider. Used by
    // the TUI "skip" (Esc) path so the wizard doesn't reappear next launch,
    // while leaving any existing config routes untouched.
    skipOnboarding() {
      const config = getConfig();
      const nextConfig = { ...config };
      nextConfig.onboarding = {
        ...(nextConfig.onboarding || {}),
        completed: true,
        version: ONBOARDING_VERSION,
        completedAt: new Date().toISOString(),
        skipped: true,
      };
      saveConfigAndAdopt(nextConfig);
      return this.getOnboardingStatus();
    },
    getAutoClear() {
      const config = getConfig();
      const route = getRoute();
      const normalized = normalizeAutoClearConfig(config.autoClear);
      const provider = route?.provider || null;
      const providerDefault = autoClearIdleMsForProvider(provider, normalized.providerIdleMs);
      const idleMs = normalized.custom ? normalized.idleMs : providerDefault;
      // Advanced picker shows only providers the user actually has enabled
      // (config.providers[*].enabled), plus the active route provider, any
      // provider with a custom override, and the 'default' fallback row —
      // not the full built-in table.
      const enabledProviders = new Set(
        Object.entries(config?.providers || {})
          .filter(([, v]) => v && typeof v === 'object' && v.enabled !== false)
          .map(([k]) => String(k).toLowerCase()),
      );
      if (provider) enabledProviders.add(String(provider).toLowerCase());
      const providerDefaults = autoClearProviderDefaults(normalized.providerIdleMs)
        .filter((entry) => entry.provider === 'default'
          || entry.custom === true
          || enabledProviders.has(entry.provider));
      return {
        enabled: normalized.enabled,
        idleMs,
        custom: normalized.custom,
        providerDefault,
        provider,
        providerDefaults,
        minContextPercent: normalized.minContextPercent,
      };
    },
    // --- User profile (/profile statusline command) ---------------------
    // getProfile returns the normalized profile plus resolved catalog entries
    // and full picker lists for language and development experience.
    getProfile() {
      const config = getConfig();
      // In-memory config is flat: `config.profile` is what the save path
      // (buildAgentSaveBuilder) persists into the on-disk `agent.profile`
      // slot. Fall back to a nested `agent.profile` only for any stray
      // nested snapshot.
      const stored = config?.profile ?? config?.agent?.profile;
      const profile = cfgMod.normalizeProfileConfig(stored);
      return {
        ...profile,
        languageEntry: cfgMod.profileLanguageEntry(profile.language),
        languages: cfgMod.PROFILE_LANGUAGES,
        experienceLevelEntry: cfgMod.profileExperienceLevelEntry(profile.experienceLevel),
        experienceLevels: cfgMod.PROFILE_EXPERIENCE_LEVELS,
      };
    },
    // setProfile patches title, language, and/or development experience.
    // Prompt-side injection is wired separately; this owns the stored value.
    getDisabledSkills() {
      const config = getConfig();
      return cfgMod.normalizeSkillsConfig(config.skills);
    },
    setDisabledSkills(disabled) {
      const names = disabled instanceof Set
        ? [...disabled]
        : (Array.isArray(disabled) ? disabled : []);
      // Adopt in-memory synchronously so getDisabledSkills reflects the new
      // value on the same tick (matches normalizeSkillsConfig({ disabled })
      // used by patchSkillsDisabled). Defer the heavy in-lock file RMW through
      // the skills debounce channel so the settings-toggle key handler does not
      // hitch on a synchronous disk write.
      const nextSkills = cfgMod.normalizeSkillsConfig({ disabled: names });
      adoptConfig({ ...getConfig(), skills: nextSkills });
      scheduleSkillsSave(names);
      return this.getDisabledSkills();
    },
    setProfile(input = {}) {
      const config = getConfig();
      const current = cfgMod.normalizeProfileConfig(config?.profile ?? config?.agent?.profile);
      const next = { ...current };
      if (hasOwn(input, 'title') || hasOwn(input, 'name')) {
        next.title = input.title ?? input.name ?? '';
      }
      if (hasOwn(input, 'language') || hasOwn(input, 'lang')) {
        next.language = input.language ?? input.lang ?? 'system';
      }
      if (hasOwn(input, 'experienceLevel')) {
        next.experienceLevel = input.experienceLevel ?? '';
      }
      const normalized = cfgMod.normalizeProfileConfig(next);
      // Persist flat: buildAgentSaveBuilder (config.mjs saveConfig) reads
      // `config.profile` and writes it into the on-disk `agent.profile`
      // section, which the prompt builder (readAgentConfig) reads. Writing a
      // nested `agent.profile` here would be dropped by the save path.
      saveConfigAndAdopt({ ...config, profile: normalized });
      return this.getProfile();
    },
    getCompactionSettings() {
      const config = getConfig();
      return normalizeCompactionConfig(config.compaction);
    },
    setCompactionSettings(input = {}) {
      const config = getConfig();
      const current = normalizeCompactionConfig(config.compaction);
      const next = { ...current };
      if (hasOwn(input, 'auto')) next.auto = input.auto !== false;
      if (hasOwn(input, 'enabled')) next.auto = input.enabled !== false;
      // Legacy Compact type fields are intentionally ignored. There is one
      // fresh-context Compact contract for every session.
      for (const key of ['mainBufferTokens', 'mainBuffer', 'mainBufferPercent', 'mainBufferPct', 'mainBufferRatio', 'mainBufferFraction']) {
        if (hasOwn(input, key)) next[key] = input[key];
      }
      const nextConfig = { ...config };
      nextConfig.compaction = normalizeCompactionConfig(next);
      saveConfigAndAdopt(nextConfig);
      const config2 = getConfig();
      const session = getSession();
      if (session) {
        const currentSessionCompaction = { ...(session.compaction || {}) };
        for (const key of [
          'type', 'compactType', 'compact_type', 'semantic', 'semanticModel', 'prune', 'tailTurns',
          'recallMemoryTimeoutMs', 'recallIngestLimit', 'recallChunkLimit', 'recallLimit',
          'recallCycle1BatchSize', 'recallRowsPerSession', 'recallWindowSize',
          'recallConcurrency', 'recallCycle1DeadlineMs',
        ]) {
          delete currentSessionCompaction[key];
        }
        session.compaction = {
          ...currentSessionCompaction,
          ...normalizeCompactionConfig(config2.compaction),
        };
      }
      invalidateContextStatusCache();
      return normalizeCompactionConfig(config2.compaction);
    },
    // Recap toggle: user-facing switch that gates ONLY the background memory
    // cycles (1/2/3). The memory module (transcript watcher/ingest and on-demand
    // reads) is always-on. Persisted via the same
    // saveConfigAndAdopt path as compaction/autoClear. The memory runtime
    // re-reads recap from the agent config section each cycle tick, so toggling
    // takes effect without a restart (no memory-service stop/start here).
    getRecapSettings() {
      return { enabled: recapEnabledFn() };
    },
    setRecapEnabled(enabled) {
      const config = getConfig();
      const nextConfig = setRecapEnabledInConfig({ ...config }, enabled !== false);
      saveConfigAndAdopt(nextConfig);
      invalidatePreSessionToolSurface();
      invalidateContextStatusCache();
      return this.getRecapSettings();
    },
    getToolModuleSettings() {
      const config = getConfig();
      return {
        webSearch: { enabled: webSearchEnabled() },
        memory: { enabled: memoryToolsEnabledFn(), installed: builtinInstalled(config, 'memory') },
        git: { enabled: gitToolsEnabledFn(), installed: builtinInstalled(config, 'git') },
        office: { enabled: officeToolsEnabledFn(), installed: builtinInstalled(config, 'office') },
      };
    },
    async setWebSearchEnabled(enabled) {
      const config = getConfig();
      saveConfigAndAdopt(setModuleEnabledInConfig({ ...config }, 'webSearch', enabled !== false));
      // Empty/reserved sessions rebuild now so session entry does not still
      // advertise web_search. A conversation keeps its frozen schema.
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    async setMemoryToolsEnabled(enabled) {
      const config = getConfig();
      const memoryEnabled = enabled !== false;
      // General → Memory is the user-facing master: model tools, core-memory
      // injection, and background recap cycles move together.
      let nextConfig = setRecapEnabledInConfig(
        setMemoryToolsEnabledInConfig({ ...config }, memoryEnabled),
        memoryEnabled,
      );
      // Enabling IS activation: an explicit enable marks the feature installed
      // so the install-first gate never fights a direct toggle (TUI path).
      if (memoryEnabled) nextConfig = setBuiltinInstalledInConfig(nextConfig, 'memory', true);
      saveConfigAndAdopt(nextConfig);
      invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    async setBuiltinToolEnabled(name, enabled) {
      if (name !== 'git' && name !== 'office') {
        throw new TypeError('Built-in tool must be git or office.');
      }
      const config = getConfig();
      let nextConfig = setModuleEnabledInConfig({ ...config }, name, enabled !== false);
      // Enabling IS activation (see setMemoryToolsEnabled).
      if (enabled !== false) nextConfig = setBuiltinInstalledInConfig(nextConfig, name, true);
      saveConfigAndAdopt(nextConfig);
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    /** Extensions → Built-in Install: run the feature's preparation adapter
     *  (model pre-download, component verification), then mark it installed
     *  and enabled in one step. New sessions pick up the tool surface. */
    async installBuiltinFeature(name) {
      if (!INSTALLABLE_BUILTIN_IDS.includes(name)) {
        throw new TypeError('Built-in feature must be git, memory, or office.');
      }
      await prepareBuiltinFeature?.(name);
      const config = getConfig();
      let nextConfig = setBuiltinInstalledInConfig({ ...config }, name, true);
      nextConfig = name === 'memory'
        ? setRecapEnabledInConfig(setMemoryToolsEnabledInConfig(nextConfig, true), true)
        : setModuleEnabledInConfig(nextConfig, name, true);
      saveConfigAndAdopt(nextConfig);
      if (name === 'memory') invalidateContextStatusCache();
      await refreshEmptySessionToolPolicy?.();
      return this.getToolModuleSettings();
    },
    getChannelSettings(options = {}) {
      return {
        enabled: channelsEnabled(),
        ...(options?.includeStatus === false ? {} : { status: channels.status() }),
      };
    },
    async setChannelsEnabled(enabled) {
      const config = getConfig();
      const nextConfig = setModuleEnabledInConfig({ ...config }, 'channels', enabled !== false);
      saveConfigAndAdopt(nextConfig);
      if (!channelsEnabled()) {
        clearChannelStartTimer();
        await channels.stop('settings-disabled', { waitForExit: false }).catch(() => {});
      }
      invalidatePreSessionToolSurface();
      return this.getChannelSettings();
    },
    getSystemShell() {
      const config = getConfig();
      return normalizeSystemShellConfig(config.shell);
    },
    setSystemShell(input = {}) {
      const config = getConfig();
      const command = normalizeSystemShellCommand(typeof input === 'string' ? input : input?.command);
      saveConfigAndAdopt({
        ...config,
        shell: command ? { ...(config.shell || {}), command } : {},
      });
      setConfiguredShell(command);
      return normalizeSystemShellConfig(getConfig().shell);
    },
    setAutoClear(input = {}) {
      const config = getConfig();
      const current = normalizeAutoClearConfig(config.autoClear);
      const next = { ...current };
      if (hasOwn(input, 'enabled')) next.enabled = input.enabled !== false;
      if (hasOwn(input, 'minContextPercent')) {
        const rawMinPct = Number(input.minContextPercent);
        if (!Number.isFinite(rawMinPct)) throw new Error('autoclear minContextPercent must be a number between 0 and 100');
        next.minContextPercent = Math.min(100, Math.max(0, Math.round(rawMinPct)));
      }
      const providerKey = String(input.provider || '').trim().toLowerCase();
      const editsProviderDefault = providerKey
        && (input.resetProvider === true || hasOwn(input, 'duration') || hasOwn(input, 'idleMs'));
      if (editsProviderDefault) {
        const providerIdleMs = { ...(next.providerIdleMs || {}) };
        if (input.resetProvider === true || (hasOwn(input, 'idleMs') && input.idleMs == null)) {
          delete providerIdleMs[providerKey];
        } else {
          const idleMs = hasOwn(input, 'duration') ? parseDurationMs(input.duration) : Number(input.idleMs);
          if (!idleMs || !Number.isFinite(idleMs) || idleMs <= 0) throw new Error('usage: duration like 10m, 1h, or 24h');
          providerIdleMs[providerKey] = Math.max(60_000, Math.round(idleMs));
        }
        next.providerIdleMs = providerIdleMs;
        saveConfigAndAdopt({ ...config, autoClear: next });
        const resolved = this.getAutoClear();
        return { ...resolved, label: formatDurationMs(resolved.idleMs) };
      }
      if (input.reset === true || (hasOwn(input, 'idleMs') && input.idleMs == null)) {
        next.idleMs = null;
      } else if (hasOwn(input, 'idleMs')) {
        const idleMs = Number(input.idleMs);
        if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('autoclear idleMs must be a positive number');
        next.idleMs = Math.max(60_000, Math.round(idleMs));
      }
      if (hasOwn(input, 'duration')) {
        const idleMs = parseDurationMs(input.duration);
        if (!idleMs) throw new Error('usage: /autoclear [on|off|status|<minutes|1h|90m>]');
        next.idleMs = idleMs;
        if (!hasOwn(input, 'enabled')) next.enabled = true;
      }
      saveConfigAndAdopt({ ...config, autoClear: next });
      const resolved = this.getAutoClear();
      return { ...resolved, label: formatDurationMs(resolved.idleMs) };
    },
    getUpdateSettings() {
      const updateCheckState = getUpdateCheckState();
      return {
        autoUpdate: autoUpdateEnabled(),
        currentVersion: updateCheckState.currentVersion || localPackageVersion(),
        latestVersion: updateCheckState.latestVersion,
        updateAvailable: updateCheckState.updateAvailable,
        lastCheckedAt: updateCheckState.lastCheckedAt,
      };
    },
    setAutoUpdate(enabled) {
      const config = getConfig();
      saveConfigAndAdopt({
        ...config,
        update: { ...(config.update || {}), auto: enabled === true },
      });
      return this.getUpdateSettings();
    },
    async checkForUpdate(options = {}) {
      await checkForUpdateInternal({ force: options?.force === true });
      return this.getUpdateSettings();
    },
    async runUpdateNow() {
      const state = await runUpdateNowInternal();
      return { ok: state.phase === 'installed', ...state };
    },
    getUpdateStatus() {
      return { ...getUpdateProcessState() };
    },
  };
}
