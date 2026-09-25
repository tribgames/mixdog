// maintenance-pickers/developer-picker.mjs
// Settings → Developer: level 1 lists the developer sections, level 2 the
// selected section's options as On/Off toggles. Both levels render from
// store.getDeveloperSettings(), so a new section or option needs no code here.

const optionMeta = (option) => {
  if (option.envForced) return 'On (env)';
  return option.enabled ? 'On' : 'Off';
};

export function createDeveloperPicker({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }) {
  const readSettings = async () => {
    try {
      return (await store.getDeveloperSettings?.()) || { sections: [] };
    } catch (e) {
      store.pushNotice(`developer settings unavailable: ${e?.message || e}`, 'error');
      return { sections: [] };
    }
  };

  const openDeveloperPicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    // Surface claim, same rule as the Auto-clear panel: every paint
    // re-validates, so a read settling after Esc never paints over the user's
    // surface.
    const own = surface.claim();
    const panelFailed = (e) => store.pushNotice(`developer panel failed: ${e?.message || e}`, 'error');

    const renderSection = async (sectionId, focus) => {
      const settings = await readSettings();
      const section = settings.sections.find((entry) => entry.id === sectionId);
      if (!section) {
        void renderSections(sectionId).catch(panelFailed);
        return;
      }
      const applyOption = (option, enabled) => {
        if (!option) return;
        if (option.envForced) {
          store.pushNotice(`${option.label} is forced on by ${option.env}`, 'warn');
          return;
        }
        if (option.enabled === enabled) return;
        // Bound to the claim on this keypress: a write acking after Esc must
        // not re-open the panel.
        const settled = own.defer(() => {
          void renderSection(sectionId, option.id).catch(panelFailed);
        });
        void Promise.resolve(store.setDeveloperOption?.(option.id, enabled))
          .then((next) => {
            if (!next) {
              store.pushNotice('developer settings unavailable', 'warn');
              return;
            }
            store.pushNotice(`${option.label} ${enabled ? 'on' : 'off'}`, 'info');
          })
          .catch((e) => store.pushNotice(`${option.label} failed: ${e?.message || e}`, 'error'))
          .finally(settled);
      };
      const items = section.options.map((option) => ({
        value: option.id,
        label: option.label,
        meta: optionMeta(option),
        description: option.envForced ? `${option.description} Forced on by ${option.env}.` : option.description,
        _option: option,
      }));
      const initialIndex = focus ? Math.max(0, items.findIndex((item) => item.value === focus)) : undefined;
      own.paint({
        title: `Developer · ${section.label}`,
        description: 'Developer-only options.',
        help: '↑/↓ Select · ←/→ Toggle On/Off · Enter Toggle · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 10,
        items,
        initialIndex,
        onLeft: (item) => applyOption(item?._option, false),
        onRight: (item) => applyOption(item?._option, true),
        onSelect: (_value, item) => applyOption(item?._option, !item?._option?.enabled),
        onCancel: () => {
          void renderSections(sectionId).catch(panelFailed);
        },
      });
    };

    const renderSections = async (focus) => {
      const settings = await readSettings();
      const items = settings.sections.map((section) => ({
        value: section.id,
        label: section.label,
        meta: `${section.options.filter((option) => option.enabled).length} on`,
        description: section.options.map((option) => option.label).join(', '),
      }));
      const initialIndex = focus ? Math.max(0, items.findIndex((item) => item.value === focus)) : undefined;
      own.paint({
        title: 'Developer',
        description: 'Developer-only options.',
        help: '↑/↓ Select · Enter Open · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 10,
        items,
        initialIndex,
        onSelect: (value) => {
          void renderSection(value).catch(panelFailed);
        },
        onCancel: () => {
          own.close();
          if (returnTo) returnTo();
        },
      });
    };

    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    return Promise.resolve(renderSections()).catch(panelFailed);
  };

  return { openDeveloperPicker };
}
