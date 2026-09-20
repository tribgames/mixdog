// maintenance-pickers/profile-picker.mjs
// The Profile panel: title, development experience and response language,
// cycled with ←/→ and written through the daemon before the panel rebuilds.
const DEFAULT_LANGUAGES = [{ id: 'system', label: 'System (locale)' }];

const DEFAULT_EXPERIENCE_LEVELS = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'vibe-coder', label: 'Vibe coder' },
  { id: 'junior', label: 'Junior' },
  { id: 'expert', label: 'Expert' },
];

/** The profile read normalized for the panel: the option lists with their
 *  built-in fallbacks and the currently selected entries. */
function profileView(profile) {
  const languages =
    Array.isArray(profile?.languages) && profile.languages.length ? profile.languages : DEFAULT_LANGUAGES;
  const currentLangId = profile?.language || 'system';
  const experienceLevels =
    Array.isArray(profile?.experienceLevels) && profile.experienceLevels.length
      ? profile.experienceLevels
      : DEFAULT_EXPERIENCE_LEVELS;
  const currentExperienceLevelId = profile?.experienceLevel || '';
  return {
    languages,
    currentLangId,
    currentLang: languages.find((lang) => lang.id === currentLangId) || languages[0],
    experienceLevels,
    currentExperienceLevelId,
    currentExperienceLevel: experienceLevels.find((level) => level.id === currentExperienceLevelId) || null,
    titleValue: String(profile?.title || '').trim(),
  };
}

export function createProfilePicker({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }) {
  const openProfilePicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim (panel-surface.mjs): getProfile() is a daemon read, so Esc
    // can land before the first paint.
    const own = surface.claim();
    let profile = null;
    try {
      profile = (await store.getProfile?.()) || null;
    } catch {
      profile = null;
    }
    const view = profileView(profile);
    // setProfile is a daemon write: rebuild the panel only after it settles so
    // the row cannot show a value the daemon rejected (and so a rejected write
    // cannot escape as an unhandled rejection).
    // Bound to the claim when the cycle keypress builds its chain: a setProfile
    // that acks after Esc must not re-open the Profile panel.
    const reopenProfile = () =>
      own.defer(() => {
        void Promise.resolve(openProfilePicker({ returnTo })).catch((e) =>
          store.pushNotice(`profile panel failed: ${e?.message || e}`, 'error')
        );
      });
    const writeProfile = (patch, notice) => {
      void Promise.resolve(store.setProfile?.(patch))
        .then(() => store.pushNotice(notice, 'info'))
        .catch((e) => store.pushNotice(`profile update failed: ${e?.message || e}`, 'error'))
        .finally(reopenProfile());
    };
    const cycleLanguage = (direction = 1) => {
      const { languages, currentLangId } = view;
      const idx = Math.max(
        0,
        languages.findIndex((lang) => lang.id === currentLangId)
      );
      const next = languages[(idx + direction + languages.length) % languages.length];
      writeProfile({ language: next.id }, `Language set to ${next.label}`);
    };
    const cycleExperienceLevel = (direction = 1) => {
      const { experienceLevels, currentExperienceLevelId } = view;
      const idx = experienceLevels.findIndex((level) => level.id === currentExperienceLevelId);
      let nextIdx = (idx + direction + experienceLevels.length) % experienceLevels.length;
      if (idx < 0) nextIdx = direction < 0 ? experienceLevels.length - 1 : 0;
      const next = experienceLevels[nextIdx];
      writeProfile({ experienceLevel: next.id }, `Experience level set to ${next.label}`);
    };
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    own.paint({
      title: 'Profile',
      description: 'How the assistant addresses you, adapts terminology, and chooses its response language.',
      help: '↑/↓ Select · ←/→ Change · Enter Edit · Esc Close',
      indexMode: 'always',
      labelWidth: 12,
      metaWidth: 20,
      items: [
        {
          value: 'title',
          label: 'Title',
          meta: view.titleValue || '(not set)',
          description: 'Preferred form of address. Enter to edit.',
          _action: 'title',
        },
        {
          value: 'experience-level',
          label: 'Experience',
          meta: view.currentExperienceLevel?.label || '(not set)',
          description: 'Development experience. ←/→ to change, Enter to cycle.',
          _action: 'experience-level',
        },
        {
          value: 'language',
          label: 'Language',
          meta: view.currentLang?.label || 'System (locale)',
          description: 'Response language. ←/→ to change, Enter to cycle.',
          _action: 'language',
        },
      ],
      onLeft: (item) => {
        if (item?._action === 'language') cycleLanguage(-1);
        else if (item?._action === 'experience-level') cycleExperienceLevel(-1);
      },
      onRight: (item) => {
        if (item?._action === 'language') cycleLanguage(1);
        else if (item?._action === 'experience-level') cycleExperienceLevel(1);
      },
      onSelect: (_value, item) => {
        if (item?._action === 'title') {
          own.close();
          setSettingsPrompt({
            kind: 'profile-title',
            label: 'Profile · Title',
            hint: 'How should the assistant address you? Leave blank to clear.',
          });
        } else if (item?._action === 'language') {
          cycleLanguage(1);
        } else if (item?._action === 'experience-level') {
          cycleExperienceLevel(1);
        }
      },
      onCancel: () => {
        own.close();
        if (returnTo) returnTo();
      },
    });
  };

  return { openProfilePicker };
}
