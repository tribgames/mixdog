/**
 * theme-effort-pickers.mjs — the Theme picker + Effort picker cluster.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory (these openers drive setPicker + the prompt/pane setters and read
 * live App state, so they can't be pure). Every function body is the original
 * App logic verbatim, with closure identifiers threaded through the factory
 * argument. themeNotice moves here alongside its sole external callers being
 * re-exported so the runSlashCommand /theme-by-id path keeps using it.
 */
import { theme } from '../theme.mjs';

export const themeNotice = (applied) => `Theme set to ${applied?.label || applied?.id || 'default'}`;

export function createThemeEffortPickers({
  state,
  store,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  setContextPanel,
  closeUsagePanel,
  clean,
}) {
  const openThemePicker = (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const onboarding = options.onboarding || null;
    let themes = [];
    try {
      themes = store.listThemes?.() || [];
    } catch (e) {
      store.pushNotice(`could not list themes: ${e?.message || e}`, 'error');
      return;
    }
    if (!themes.length) {
      store.pushNotice('no themes available', 'warn');
      return;
    }
    const currentId = store.getTheme?.() || themes.find((t) => t.current)?.id || themes[0]?.id;
    let highlightedThemeId = currentId;
    const items = themes.map((entry) => ({
      value: entry.id,
      label: entry.label || entry.id,
      marker: entry.id === currentId ? '✓' : '',
      description: entry.description || 'color theme',
      _theme: entry,
    }));
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    setContextPanel(null);
    closeUsagePanel();
    const applyTheme = (id, { persist = true } = {}) => {
      try {
        return store.setTheme?.(id, { persist });
      } catch (e) {
        store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
        return null;
      }
    };
    // Onboarding: Enter (row) and ConfirmBar Next both persist the highlighted
    // theme, then advance; Back restores the original palette then steps back.
    const saveTheme = (id, { advance = false } = {}) => {
      setPicker(null);
      const applied = applyTheme(id, { persist: true });
      store.pushNotice(themeNotice(applied || { id }), 'info');
      if (advance && onboarding) onboarding.onAdvance?.();
      else if (returnTo) returnTo();
    };
    setPicker({
      title: 'Theme',
      description: 'Choose the color theme that looks best with your terminal.',
      help: onboarding ? undefined : (returnTo ? '↑/↓ Preview · Enter Choose · Esc Settings' : '↑/↓ Preview · Enter Choose · Esc Back'),
      labelWidth: 22,
      initialIndex: Math.max(0, items.findIndex((item) => item.value === currentId)),
      items,
      confirmBar: onboarding ? {
        buttons: [
          { value: 'back', label: '◀ Back' },
          { value: 'next', label: 'Next ▶' },
        ],
        onConfirm: (button) => {
          if (button.value === 'back') {
            // Restore the palette active before the picker opened, then step back.
            if (currentId) applyTheme(currentId, { persist: false });
            onboarding.onBack?.();
            return;
          }
          saveTheme(highlightedThemeId, { advance: true });
        },
      } : (options.confirmBar || null),
      // Live preview while moving: apply (no persist) so the surface re-tones
      // as the selection moves. Enter persists; Esc restores the original.
      onHighlight: (_value, item) => {
        if (item?._theme?.id) {
          highlightedThemeId = item._theme.id;
          applyTheme(item._theme.id, { persist: false });
        }
      },
      onSelect: (_value, item) => {
        const entry = item?._theme;
        if (!entry) return;
        saveTheme(entry.id, { advance: Boolean(onboarding) });
      },
      onCancel: () => {
        setPicker(null);
        // Restore the theme that was active before the picker opened.
        if (currentId) applyTheme(currentId, { persist: false });
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  const openEffortPicker = () => {
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const items = Array.isArray(state.effortOptions) && state.effortOptions.length > 0
      ? state.effortOptions
      : [];
    if (!items.length) {
      store.pushNotice('Current model has no effort levels.', 'warn');
      return;
    }
    const current = state.effort || items[0]?.value || '';
    const pickerItems = items.map((item) => ({
      ...item,
      marker: item?.value === current ? '✓' : '',
      markerColor: theme.success,
      description: clean(item?.description).toLowerCase() === 'current' ? '' : item?.description,
    }));
    setPicker({
      title: 'Effort',
      description: 'Reasoning effort for the current model.',
      items: pickerItems,
      onSelect: (value) => {
        setPicker(null);
        void store.setEffort(value)
          .then(result => store.pushNotice(result ? `Effort set to ${result}` : 'Effort switch is already running.', result ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t switch effort: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  return { openThemePicker, openEffortPicker };
}
