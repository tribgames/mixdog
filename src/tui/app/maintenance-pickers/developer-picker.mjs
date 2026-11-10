// maintenance-pickers/developer-picker.mjs
// Settings → Developer: level 1 lists the developer sections, level 2 the
// selected section's options as On/Off toggles. Both levels render from
// store.getDeveloperSettings(), so a new section or option needs no code here.
// Turning on an option that carries a `warning` goes through a confirmation
// panel showing that warning; turning an option off never asks.
import { wrapText } from '../../markdown/ansi-line-wrap.mjs';
import { theme } from '../../theme.mjs';

// Picker footers truncate each line to the panel width rather than wrap, so the
// warning is pre-wrapped to a width that still fits an 80-column terminal.
const WARNING_WRAP_COLUMNS = 60;

const optionMeta = (option) => (option.enabled ? 'On' : 'Off');

export function createDeveloperPicker({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
  clearModelCaches,
}) {
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
      const backToSection = (option) => {
        void renderSection(sectionId, option.id).catch(panelFailed);
      };
      const writeOption = (option, enabled) => {
        // Bound to the claim on this keypress: a write acking after Esc must
        // not re-open the panel.
        const settled = own.defer(() => backToSection(option));
        void Promise.resolve(store.setDeveloperOption?.(option.id, enabled))
          .then((next) => {
            if (!next) {
              store.pushNotice('developer settings unavailable', 'warn');
              return;
            }
            // A provider option adds or removes that provider's models: the
            // next /model or /agents open must not serve the cached list.
            if (option.provider) clearModelCaches?.('all');
            store.pushNotice(`${option.label} ${enabled ? 'on' : 'off'}`, 'info');
          })
          .catch((e) => store.pushNotice(`${option.label} failed: ${e?.message || e}`, 'error'))
          .finally(settled);
      };
      // Only Accept writes; Cancel and Esc return to the section unchanged.
      const confirmOption = (option) => {
        own.paint({
          title: `Turn on ${option.label}`,
          indexMode: 'always',
          labelWidth: 26,
          items: [
            { value: 'cancel', label: 'Cancel' },
            { value: 'accept', label: 'Accept risk and turn on' },
          ],
          footer: wrapText(option.warning, WARNING_WRAP_COLUMNS).map((text, index) => ({
            glyph: index === 0 ? '!' : ' ',
            color: theme.warning,
            text: text.trim(),
          })),
          onSelect: (value) => {
            if (value === 'accept') writeOption(option, true);
            else backToSection(option);
          },
          onCancel: () => backToSection(option),
        });
      };
      const applyOption = (option, enabled) => {
        if (!option || option.enabled === enabled) return;
        if (enabled && option.warning) confirmOption(option);
        else writeOption(option, enabled);
      };
      const items = section.options.map((option) => ({
        value: option.id,
        label: option.label,
        meta: optionMeta(option),
        description: option.description,
        _option: option,
      }));
      const initialIndex = focus
        ? Math.max(
            0,
            items.findIndex((item) => item.value === focus)
          )
        : undefined;
      own.paint({
        title: `Developer · ${section.label}`,
        description: 'Developer-only options.',
        help: '↑/↓ Select · ←/→ Toggle On/Off · Enter Toggle · Esc Back',
        indexMode: 'always',
        labelWidth: 26,
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
      const initialIndex = focus
        ? Math.max(
            0,
            items.findIndex((item) => item.value === focus)
          )
        : undefined;
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
