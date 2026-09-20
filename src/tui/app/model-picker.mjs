/*
 * model-picker.mjs — the Model picker cluster (openModelPicker).
 *
 * A dependency-injection factory. openModelPicker claims the panel surface,
 * resolves the catalog (model-picker/catalog-load), paints the provider list
 * and opens one provider's model list (model-picker/provider-models-list,
 * whose selections live in route-selection and whose footer is model-footer).
 * Deps pointing at a later-defined App fn (openProviderSetupPicker) thread as
 * a lazy getter wrapper so it resolves the live opener at call time; live UI
 * state (getState) is read through a getter so it always reflects the current
 * render.
 */
import { normalizeModelOptions, buildModelProviderItems } from './model-options.mjs';
import { createModelCatalog } from './model-picker/catalog-load.mjs';
import { openProviderModelsPicker, saveSelectedRoute } from './model-picker/provider-models-list.mjs';

export function createModelPicker({
  store,
  getState,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  providerModelsCacheRef,
  webSearchModelsCacheRef,
  modelPickerRequestRef,
  modelSwitchNotice,
  openProviderSetupPicker,
}) {
  const catalog = createModelCatalog({ store, providerModelsCacheRef, webSearchModelsCacheRef });

  const openModelPicker = async (options = {}) => {
    const state = getState();
    // Surface claim for this picker (panel-surface.mjs): every paint — the
    // loading frame, the provider list, the per-provider model list — proves
    // ownership through it, and each paint re-arms it because a paint can
    // itself be the handover. modelPickerRequestRef only orders concurrent
    // OPENS; it cannot see an Esc that closed this one, so a model load
    // settling afterwards used to repaint the dismissed picker.
    const own = surface.claim();
    setProviderPrompt(null);
    setSettingsPrompt(null);
    modelPickerRequestRef.current += 1;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const returnLabel = String(options.returnLabel || 'Agents');
    const returnOnNestedCancel = options.returnOnNestedCancel === true;
    const handoffPanel = options.handoffPanel && typeof options.handoffPanel === 'object' ? options.handoffPanel : null;
    const cancelModelPicker = () => {
      if (returnTo) returnTo();
      else own.close();
    };
    const paint = (panel) => own.paint(panel);
    const listHelp = returnTo ? `↑/↓ Select · Enter Open · Esc ${returnLabel}` : '↑/↓ Select · Enter Open · Esc Back';
    const loaded = await catalog.loadCatalog(options, () =>
      paint({
        title: options.title || 'Model',
        description: options.loadingDescription || 'Loading models...',
        help: listHelp,
        loading: true,
        items: [],
        onCancel: cancelModelPicker,
      })
    );
    if (!loaded) return;
    const { providerModels } = loaded;
    if (!providerModels || providerModels.length === 0) {
      store.pushNotice(options.emptyNotice || 'no provider models available; open /providers to sign in', 'warn');
      // Delegation is a paint by proxy: the empty-catalog fallback opens
      // Providers, so it must prove ownership exactly like paint().
      if (!own.owns()) return;
      void openProviderSetupPicker({
        title: 'Providers',
        continueLabel: 'Back to model setup',
        continueDescription: 'retry model list after provider auth',
        onContinue: () => void openModelPicker(options),
      });
      return;
    }

    const models = normalizeModelOptions(providerModels);
    const activeRoute = options.currentRoute || {
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fast: state.fast,
      modelParameters: state.modelParameters,
      contextPercent: state.contextPercent,
    };
    const view = {
      options,
      state,
      models,
      activeRoute,
      returnTo,
      returnLabel,
      returnOnNestedCancel,
      cancelModelPicker,
      paint,
    };
    const saveRoute = (selected, { routeInput, effort }) =>
      saveSelectedRoute({
        store,
        options,
        own,
        handoffPanel,
        markCatalogStale: catalog.markModelCatalogStale,
        modelSwitchNotice,
        routeInput,
        selected,
        effort,
      });
    let providerListHighlightProvider = null;
    const renderProviderList = (renderOptions = {}) => {
      if (renderOptions.highlightProvider) {
        providerListHighlightProvider = renderOptions.highlightProvider;
      }
      const highlightProvider = renderOptions.highlightProvider || providerListHighlightProvider || null;
      const providerItems = buildModelProviderItems(models, activeRoute);
      const providerHighlight = highlightProvider || activeRoute?.provider || null;
      const providerInitialIndex = Math.max(
        0,
        providerItems.findIndex((item) => item._provider === providerHighlight)
      );
      paint({
        title: options.title || 'Model',
        description: options.providerDescription || 'Choose a provider.',
        help: listHelp,
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 20,
        initialIndex: providerInitialIndex,
        pickerKey: `model-picker:providers:${providerHighlight || 'default'}`,
        items: providerItems,
        onSelect: (_value, item) => {
          if (!item?._provider) return;
          openProviderModelsPicker({
            view,
            provider: item._provider,
            onBack: () => renderProviderList({ highlightProvider: item._provider }),
            saveRoute,
          });
        },
        onHighlight: (_value, item) => {
          if (item?._provider) providerListHighlightProvider = item._provider;
        },
        onCancel: cancelModelPicker,
      });
    };

    renderProviderList();
    catalog.scheduleBackgroundRefresh(loaded);
  };

  return { openModelPicker };
}
