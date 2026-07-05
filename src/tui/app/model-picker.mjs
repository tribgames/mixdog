/*
 * model-picker.mjs — the Model picker cluster (openModelPicker).
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory. Every function body is the original App logic verbatim, with closure
 * identifiers threaded through the factory argument. The nested effort helpers
 * (preferredEffort/effortItemsFor/modelDefaultEffort/…) stay inside the opener.
 * Deps pointing at a later-defined App fn (openProviderSetupPicker) thread as a
 * lazy getter wrapper so it resolves the live opener at call time; live UI
 * state (getState) is read through a getter so it always reflects the current
 * render.
 */
import { theme } from '../theme.mjs';
import {
  normalizeModelOptions,
  providerDisplayName,
  effortDisplayLabel,
  fastDisplayLabel,
  buildModelProviderItems,
  buildProviderModelItems,
} from './model-options.mjs';

export function createModelPicker({
  store,
  getState,
  setPicker,
  setProviderPrompt,
  setChannelPrompt,
  setHookPrompt,
  setSettingsPrompt,
  providerModelsCacheRef,
  searchModelsCacheRef,
  modelPickerRequestRef,
  clearModelCaches,
  modelSwitchNotice,
  openProviderSetupPicker,
}) {
  const openModelPicker = async (options = {}) => {
    const state = getState();
    setProviderPrompt(null);
    setChannelPrompt(null);
    setHookPrompt(null);
    setSettingsPrompt(null);
    const modelPickerRequest = ++modelPickerRequestRef.current;
    let modelPickerClosed = false;
    let activeModelProvider = null;
    let providerListHighlightProvider = null;
    const isActiveModelPicker = () => !modelPickerClosed && modelPickerRequestRef.current === modelPickerRequest;
    const returnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    const returnLabel = String(options.returnLabel || 'Agents');
    const returnOnNestedCancel = options.returnOnNestedCancel === true;
    const cancelModelPicker = () => {
      modelPickerClosed = true;
      if (returnTo) returnTo();
      else setPicker(null);
    };
    const cacheRef = options.cacheRef === 'search' ? searchModelsCacheRef : providerModelsCacheRef;
    const loadModels = typeof options.loadModels === 'function' ? options.loadModels : store.listProviderModels;
    let providerModels = Array.isArray(cacheRef.current.models)
      ? cacheRef.current.models
      : [];
    let refreshModelsPromise = null;
    let renderedQuickModels = false;
    if (!providerModels.length || options.refreshModels === true) {
      setPicker({
        title: options.title || 'Model',
        description: options.loadingDescription || 'Loading models...',
        help: returnTo ? `↑/↓ Select · Enter Open · Esc ${returnLabel}` : '↑/↓ Select · Enter Open · Esc Back',
        items: [],
        onCancel: cancelModelPicker,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        if (options.refreshModels !== true && options.cacheRef !== 'search') {
          refreshModelsPromise = Promise.resolve(loadModels({ force: false }));
          providerModels = await loadModels({ quick: true });
          renderedQuickModels = Array.isArray(providerModels) && providerModels.length > 0;
          if (!renderedQuickModels) {
            providerModels = await refreshModelsPromise;
          }
        } else {
          providerModels = await loadModels({ force: options.refreshModels === true });
        }
        cacheRef.current = { models: providerModels, at: Date.now() };
      } catch (e) {
        store.pushNotice(`could not list models: ${e?.message || e}`, 'error');
        return;
      }
    }

    if (!providerModels || providerModels.length === 0) {
      store.pushNotice(options.emptyNotice || 'no provider models available; open /providers to sign in', 'warn');
      void openProviderSetupPicker({
        title: 'Providers',
        continueLabel: 'Back to model setup',
        continueDescription: 'retry model list after provider auth',
        onContinue: () => void openModelPicker(options),
      });
      return;
    }

    let models = normalizeModelOptions(providerModels);
    const activeRoute = options.currentRoute || {
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      fast: state.fast,
    };
    const renderModelPicker = (renderOptions = {}) => {
      if (renderOptions.highlightProvider) {
        providerListHighlightProvider = renderOptions.highlightProvider;
      }
      const highlightProvider = renderOptions.highlightProvider || providerListHighlightProvider || null;
      activeModelProvider = null;
      const openProviderModelsPicker = (provider) => {
        if (!provider) return;
        activeModelProvider = provider;
        const providerModels = models.filter((model) => model.provider === provider);
        const preferredEffort = (values = []) => {
          const allowed = values.filter(Boolean);
          for (const value of ['high', 'medium', 'low', 'none', 'xhigh', 'max']) {
            if (allowed.includes(value)) return value;
          }
          return allowed[0] || null;
        };
        const effortItemsFor = (model) => Array.isArray(model?.effortOptions) && model.effortOptions.length > 0
          ? model.effortOptions
          : [];
        const modelEffortValues = (model) => effortItemsFor(model).map((effort) => effort.value).filter(Boolean);
        const modelDefaultEffort = (model) => {
          const values = modelEffortValues(model);
          if (!values.length) return null;
          const currentRoute = options.currentRoute || null;
          if (currentRoute?.provider === model.provider && currentRoute?.model === model.id && currentRoute.effort && values.includes(currentRoute.effort)) return currentRoute.effort;
          if (model.provider === state.provider && model.id === state.model && state.effort && values.includes(state.effort)) return state.effort;
          if (model.savedEffort && values.includes(model.savedEffort)) return model.savedEffort;
          return preferredEffort(values);
        };
        const selectedEfforts = new Map();
        const modelKey = (model) => `${model?.provider || ''}\n${model?.id || ''}`;
        const getSelectedEffort = (model) => {
          if (!model) return null;
          const key = modelKey(model);
          if (selectedEfforts.has(key)) return selectedEfforts.get(key);
          const effort = modelDefaultEffort(model);
          selectedEfforts.set(key, effort);
          return effort;
        };
        const setSelectedEffort = (model, effort) => {
          if (!model) return;
          selectedEfforts.set(modelKey(model), effort || null);
        };
        const selectedFast = new Map();
        const modelDefaultFast = (model) => {
          if (!model?.fastCapable) return false;
          const currentRoute = options.currentRoute || null;
          if (currentRoute?.provider === model.provider && currentRoute?.model === model.id && typeof currentRoute.fast === 'boolean') return currentRoute.fast;
          if (model.provider === state.provider && model.id === state.model && typeof state.fast === 'boolean') return state.fast;
          if (typeof model.savedFast === 'boolean') return model.savedFast;
          return model.fastPreferred === true;
        };
        const getSelectedFast = (model) => {
          if (!model) return false;
          const key = modelKey(model);
          if (selectedFast.has(key)) return selectedFast.get(key) === true;
          const fast = modelDefaultFast(model);
          selectedFast.set(key, fast);
          return fast;
        };
        const toggleFast = (model) => {
          if (!model?.fastCapable) return;
          selectedFast.set(modelKey(model), !getSelectedFast(model));
          renderProviderModels();
        };
        const providerEffortItems = () => {
          const seen = new Set();
          const out = [];
          for (const effort of providerModels.flatMap((model) => effortItemsFor(model))) {
            if (!effort?.value || seen.has(effort.value)) continue;
            seen.add(effort.value);
            out.push(effort);
          }
          return out;
        };
        const effortLabel = (value) => {
          const found = providerEffortItems().find((effort) => effort.value === value);
          return effortDisplayLabel(found?.label || value || '');
        };
        const effortGlyph = (value) => {
          if (value === 'none') return '○';
          if (value === 'low') return '◔';
          if (value === 'medium') return '◑';
          if (value === 'high') return '◕';
          if (value === 'max') return '◆';
          return '●';
        };
        const effortColor = (value) => {
          if (value === 'none') return theme.inactive;
          if (value === 'low') return theme.warning;
          if (value === 'medium') return theme.claude;
          if (value === 'high') return theme.error;
          if (value === 'max') return theme.permission;
          return theme.error;
        };
        const modelFooter = (model = null) => {
          const items = model ? effortItemsFor(model) : providerEffortItems();
          const values = items.map((effort) => effort.value).filter(Boolean);
          const fastCapable = model?.fastCapable === true;
          const fastOn = fastCapable && getSelectedFast(model);
          const fastLine = fastCapable
            ? { glyph: fastOn ? '●' : '○', color: fastOn ? theme.fastMode : theme.inactive, text: `${fastDisplayLabel(fastOn)} · Tab Toggle` }
            : null;
          if (!values.length) {
            return fastLine ? [fastLine] : '';
          }
          let selectedEffort = getSelectedEffort(model);
          if (!values.includes(selectedEffort)) {
            selectedEffort = modelDefaultEffort(model);
            setSelectedEffort(model, selectedEffort);
          }
          const effortLine = {
            glyph: effortGlyph(selectedEffort),
            color: effortColor(selectedEffort),
            text: `${effortLabel(selectedEffort)} Effort ←/→ To Adjust`,
          };
          return fastLine ? [effortLine, fastLine] : [effortLine];
        };
        const coerceEffort = (model) => {
          const values = modelEffortValues(model);
          if (!values.length) return null;
          const selectedEffort = getSelectedEffort(model);
          return values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
        };
        const cycleEffort = (model, direction = 1) => {
          const values = modelEffortValues(model);
          if (values.length === 0) return;
          const selectedEffort = getSelectedEffort(model);
          const currentValue = values.includes(selectedEffort) ? selectedEffort : modelDefaultEffort(model);
          const current = values.includes(currentValue) ? values.indexOf(currentValue) : 0;
          setSelectedEffort(model, values[(current + direction + values.length) % values.length] || null);
          renderProviderModels();
        };
        const applyModel = (item) => {
          const selected = item?._model || models.find((m) => m.provider === item?._provider && m.id === item?._modelId);
          if (!selected) return;
          modelPickerClosed = true;
          const effort = coerceEffort(selected);
          const routeInput = {
            provider: selected.provider,
            model: selected.id,
            ...(effort ? { effort } : {}),
            ...(selected.fastCapable ? { fast: getSelectedFast(selected) } : {}),
          };
          if (typeof options.onSelectRoute === 'function') {
            const savePromise = Promise.resolve(options.onSelectRoute(routeInput, selected, effort));
            if (typeof options.onImmediateSelect === 'function') {
              options.onImmediateSelect(routeInput, selected, effort);
            } else {
              setPicker(null);
            }
            void savePromise
              .then((result) => {
                if (result) clearModelCaches('all');
                if (typeof options.onAfterSelect === 'function') options.onAfterSelect();
                return result;
              })
              .catch((e) => store.pushNotice(`Couldn’t save model: ${e?.message || e}`, 'error'));
            return;
          }
          setPicker(null);
          void store.setRoute(routeInput)
            .then((ok) => {
              if (ok) clearModelCaches('provider');
              store.pushNotice(
                ok
                  ? modelSwitchNotice()
                  : 'Model switch is already running',
                ok ? 'info' : 'warn',
              );
              if (ok && typeof options.onAfterSelect === 'function') options.onAfterSelect();
            })
            .catch((e) => store.pushNotice(`Couldn’t switch model: ${e?.message || e}`, 'error'));
        };
        const renderProviderModels = () => {
          const providerModelItems = buildProviderModelItems(models, provider, activeRoute);
          const providerModelInitialIndex = Math.max(
            0,
            providerModelItems.findIndex(
              (item) => item._provider === activeRoute?.provider && item._modelId === activeRoute?.model,
            ),
          );
          setPicker({
            title: providerDisplayName(provider),
            description: options.modelDescription || 'Select a model. Adjust Effort with ←/→.',
            footer: (item) => modelFooter(item?._model),
            help: returnOnNestedCancel && returnTo
              ? `↑/↓ Select · ←/→ Effort · Tab Fast · Enter Save · Esc ${returnLabel}`
              : '↑/↓ Select · ←/→ Effort · Tab Fast · Enter Save · Esc Back',
            indexMode: 'always',
            initialIndex: providerModelInitialIndex,
            pickerKey: `model-picker:provider-models:${provider}`,
            items: providerModelItems,
            onSelect: (_value, item) => applyModel(item),
            onLeft: (item) => {
              if (item?._model) cycleEffort(item._model, -1);
            },
            onRight: (item) => {
              if (item?._model) cycleEffort(item._model, 1);
            },
            onTab: (item) => {
              if (item?._model) toggleFast(item._model);
            },
            onCancel: () => {
              if (returnOnNestedCancel && returnTo) cancelModelPicker();
              else renderModelPicker({ highlightProvider: provider });
            },
          });
        };
        renderProviderModels();
      };
      const providerItems = buildModelProviderItems(models, activeRoute);
      const providerHighlight = highlightProvider || activeRoute?.provider || null;
      const providerInitialIndex = Math.max(
        0,
        providerItems.findIndex((item) => item._provider === providerHighlight),
      );
      setPicker({
        title: options.title || 'Model',
        description: options.providerDescription || 'Choose a provider.',
        help: returnTo ? `↑/↓ Select · Enter Open · Esc ${returnLabel}` : '↑/↓ Select · Enter Open · Esc Back',
        indexMode: 'always',
        labelWidth: 18,
        metaWidth: 20,
        initialIndex: providerInitialIndex,
        pickerKey: `model-picker:providers:${providerHighlight || 'default'}`,
        items: providerItems,
        onSelect: (_value, item) => {
          if (item?._provider) openProviderModelsPicker(item._provider);
        },
        onHighlight: (_value, item) => {
          if (item?._provider) providerListHighlightProvider = item._provider;
        },
        onCancel: cancelModelPicker,
      });
    };

    renderModelPicker();
    if (renderedQuickModels && refreshModelsPromise) {
      void refreshModelsPromise
        .then((freshModels) => {
          if (!isActiveModelPicker()) return;
          if (!Array.isArray(freshModels) || freshModels.length === 0) return;
          providerModels = freshModels;
          models = normalizeModelOptions(providerModels);
          cacheRef.current = { models: providerModels, at: Date.now() };
          if (activeModelProvider === null) {
            renderModelPicker();
          }
        })
        .catch(() => {});
    }
  };

  return { openModelPicker };
}
