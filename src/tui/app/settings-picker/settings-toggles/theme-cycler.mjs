// settings-picker/settings-toggles/theme-cycler.mjs
// The one Settings cycler that is entirely synchronous: themes are listed and
// applied in-process, so there is no ack to defer — it refreshes Settings
// directly instead of through a keypress-bound deferred refresh.
import { cycled } from './cycled.mjs';

export function createThemeCycler({ store, themeNotice, refreshSettings }) {
  const cycleTheme = (direction = 1) => {
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
    const next = cycled(
      themes,
      themes.findIndex((t) => t.id === currentId),
      direction
    );
    try {
      const applied = store.setTheme?.(next.id, { persist: true });
      store.pushNotice(themeNotice(applied || next), 'info');
    } catch (e) {
      store.pushNotice(`Couldn’t set theme: ${e?.message || e}`, 'error');
    }
    refreshSettings();
  };

  return { cycleTheme };
}
