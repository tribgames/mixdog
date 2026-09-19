// Onboarding, the user profile (/profile) and the disabled-skill list. Methods
// reference `this.*` so cross-member calls resolve against the facade object
// these are spread into.
export function createProfileSettings({
  getConfig,
  adoptConfig,
  saveConfigAndAdopt,
  scheduleSkillsSave,
  cfgMod,
  hasOwn,
  summarizeWorkflowRoutes,
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
    getDisabledSkills() {
      const config = getConfig();
      return cfgMod.normalizeSkillsConfig(config.skills);
    },
    setDisabledSkills(disabled) {
      let names = [];
      if (disabled instanceof Set) names = [...disabled];
      else if (Array.isArray(disabled)) names = disabled;
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
  };
}
