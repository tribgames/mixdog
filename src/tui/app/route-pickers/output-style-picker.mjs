// route-pickers/output-style-picker.mjs
// The Output Style list, in its Settings form (Enter saves and returns) and
// its onboarding form (row select or the ConfirmBar's Next saves, then the
// wizard advances).
import { theme } from '../../theme.mjs';
import { pickerHelp } from '../app-format.mjs';

export const outputStyleNotice = (result) => {
  const label = result?.current?.label || result?.current?.id || result?.configured || 'Default';
  return result?.appliedToCurrentSession === false
    ? `Output style set to ${label}. Use /clear to apply to this chat.`
    : `Output style set to ${label}.`;
};

export function createOutputStylePicker({ store, surface, setProviderPrompt, setSettingsPrompt, closeUsagePanel }) {
  const openOutputStylePicker = async (options = {}) => {
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const handoffPanel = options.handoffPanel && typeof options.handoffPanel === 'object' ? options.handoffPanel : null;
    // Onboarding mode: Enter (row select) and ConfirmBar Next must both persist
    // the chosen style, then advance. `onboarding.onAdvance/onBack` drive the
    // wizard; the confirm bar is built here so both paths share `saveStyle`.
    const onboarding = options.onboarding || null;
    const own = surface.claim();
    let status = null;
    try {
      status = (await store.listOutputStyles?.()) || null;
    } catch (e) {
      store.pushNotice(`could not list output styles: ${e?.message || e}`, 'error');
      return;
    }
    const styles = Array.isArray(status?.styles) ? status.styles : [];
    if (!styles.length) {
      store.pushNotice('no output styles available', 'warn');
      return;
    }
    const currentId = status?.current?.id || 'default';
    let highlightedStyleId = currentId;
    const items = styles.map((style) => ({
      value: style.id,
      label: style.label || style.id,
      marker: style.id === currentId ? '✓' : '',
      markerColor: theme.success,
      description: style.description || style.source || 'output style',
      _style: style,
    }));
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.context(null);
    closeUsagePanel();
    const saveStyle = (styleId, { advance = false } = {}) => {
      if (!styleId) return;
      // Onboarding advance: keep the current picker visible during the async
      // style switch so the screen never flashes empty between steps; the next
      // step (or finishOnboarding) replaces/clears the picker itself.
      if (!(advance && onboarding)) own.paint(handoffPanel);
      // Post-ack delegation (next onboarding step, or back to the caller):
      // bound after this keypress's own navigation so an Esc while the switch
      // is in flight cannot paint a panel over the new surface.
      const advanceAfterSave = own.defer(() => {
        if (advance && onboarding) onboarding.onAdvance?.();
        else if (returnTo) returnTo();
      });
      void store
        .setOutputStyle?.(styleId)
        .then((result) => {
          if (!result) {
            store.pushNotice('Output style switch is already running.', 'warn');
          } else {
            store.pushNotice(outputStyleNotice(result), 'info');
          }
          advanceAfterSave();
        })
        .catch((e) => {
          store.pushNotice(`Couldn’t switch output style: ${e?.message || e}`, 'error');
          if (handoffPanel) advanceAfterSave();
        });
    };
    own.paint({
      title: 'Output Style',
      description: 'Select response style.',
      // Onboarding uses a ConfirmBar (←/→ = Back/Next); let the Picker supply
      // its ConfirmBar help instead of a stale ←/→ hint.
      help: pickerHelp(onboarding, returnTo, '↑/↓ Select · Enter Choose'),
      labelWidth: 18,
      items,
      confirmBar: onboarding
        ? {
            buttons: [
              { value: 'back', label: '◀ Back' },
              { value: 'next', label: 'Next ▶' },
            ],
            onConfirm: (button) => {
              if (button.value === 'back') {
                own.close();
                onboarding.onBack?.();
                return;
              }
              saveStyle(highlightedStyleId, { advance: true });
            },
          }
        : options.confirmBar || null,
      onHighlight: onboarding
        ? (_value, item) => {
            if (item?._style?.id) highlightedStyleId = item._style.id;
          }
        : undefined,
      onSelect: (_value, item) => {
        const style = item?._style;
        if (!style) return;
        saveStyle(style.id, { advance: Boolean(onboarding) });
      },
      onCancel: () => {
        if (handoffPanel) own.paint(handoffPanel);
        else own.close();
        if (onboarding) onboarding.onCancel?.();
        else if (returnTo) returnTo();
      },
    });
  };

  return { openOutputStylePicker };
}
