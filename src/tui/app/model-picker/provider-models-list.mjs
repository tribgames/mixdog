// model-picker/provider-models-list.mjs
// One provider's model list: rows from the catalog, the footer for the
// highlighted row, and the keys that change its selections (←/→ effort,
// C/Shift+C context, Tab Fast, T thinking). Enter saves through the caller.
import { buildProviderModelItems, providerDisplayName } from '../model-options.mjs';
import { modelFooter } from './model-footer.mjs';
import { createRouteSelection } from './route-selection.mjs';

const MODEL_LIST_HELP = '↑/↓ Select · ←/→ Effort · C/Shift+C Context · Tab Fast · T Thinking · Enter Save';

/** Saves the route for a caller-owned save (options.onSelectRoute) or through
 *  store.setRoute. The keypress owns the hop: the destination is painted and
 *  the surface handed back on the spot; the write settles afterwards. */
export function saveSelectedRoute({
  store,
  options,
  own,
  handoffPanel,
  markCatalogStale,
  modelSwitchNotice,
  routeInput,
  selected,
  effort,
}) {
  // Waiting for the write to ack first left a "Switching model..." panel (or a
  // closed picker with an unchanged statusline) on screen for as long as the
  // runtime took — provider readiness, config save, empty-session rebuild.
  // store.setRoute previews the route immediately and reverts it if the write
  // fails.
  const handBackSurface = () => {
    if (typeof options.onAfterSelect === 'function') options.onAfterSelect();
  };
  if (typeof options.onSelectRoute === 'function') {
    const savePromise = Promise.resolve(options.onSelectRoute(routeInput, selected, effort));
    if (typeof options.onImmediateSelect === 'function') {
      options.onImmediateSelect(routeInput, selected, effort);
    } else {
      own.paint(handoffPanel);
    }
    handBackSurface();
    markCatalogStale();
    void savePromise.catch((e) => {
      store.pushNotice(`Couldn’t save model: ${e?.message || e}`, 'error');
    });
    return;
  }
  own.paint(handoffPanel);
  handBackSurface();
  markCatalogStale();
  store.pushNotice(modelSwitchNotice(), 'info');
  void store
    .setRoute(routeInput)
    .then((ok) => {
      if (ok === false) store.pushNotice('Model switch is already running', 'warn');
    })
    .catch((e) => {
      store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error');
    });
}

/** Paints the provider's model list; `onBack` returns to the provider list
 *  and `saveRoute(selected, { routeInput, effort })` performs Enter. */
export function openProviderModelsPicker({ view, provider, onBack, saveRoute }) {
  const { options, state, models, activeRoute, returnTo, returnLabel, returnOnNestedCancel, cancelModelPicker } = view;
  const providerModels = models.filter((model) => model.provider === provider);
  const selection = createRouteSelection({ providerModels, state, currentRoute: options.currentRoute || null });
  const render = () => {
    const providerModelItems = buildProviderModelItems(models, provider, activeRoute);
    const providerModelInitialIndex = Math.max(
      0,
      providerModelItems.findIndex(
        (item) => item._provider === activeRoute?.provider && item._modelId === activeRoute?.model
      )
    );
    view.paint({
      title: providerDisplayName(provider),
      description: options.modelDescription || 'Select a model. Adjust Effort with ←/→.',
      footer: (item) => modelFooter(selection, item?._model),
      help:
        returnOnNestedCancel && returnTo ? `${MODEL_LIST_HELP} · Esc ${returnLabel}` : `${MODEL_LIST_HELP} · Esc Back`,
      indexMode: 'always',
      initialIndex: providerModelInitialIndex,
      pickerKey: `model-picker:provider-models:${provider}`,
      items: providerModelItems,
      onSelect: (_value, item) => {
        const selected = item?._model || models.find((m) => m.provider === item?._provider && m.id === item?._modelId);
        if (!selected) return;
        saveRoute(selected, selection.routeInputFor(selected));
      },
      onLeft: (item) => {
        if (item?._model && selection.cycleEffort(item._model, -1)) render();
      },
      onRight: (item) => {
        if (item?._model && selection.cycleEffort(item._model, 1)) render();
      },
      onTab: (item) => {
        if (item?._model && selection.toggleFast(item._model)) render();
      },
      onKey: (input, _key, item) => {
        const model = item?._model;
        if (!model || !['c', 'C', 't', 'T'].includes(input)) return;
        if (input.toLowerCase() === 'c') {
          if (selection.stepContext(model, input === 'C' ? -1 : 1)) render();
          return;
        }
        if (selection.cycleThinking(model)) render();
      },
      onCancel: () => {
        if (returnOnNestedCancel && returnTo) cancelModelPicker();
        else onBack();
      },
    });
  };
  render();
}
