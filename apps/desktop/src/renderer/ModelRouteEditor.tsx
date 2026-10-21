import type { DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import { routeAutoEffortCapable, useAutoEffortRoute } from './auto-effort-store';
import { t } from './i18n';
import {
  modelOffersUltrafast,
  preferredModelEffort,
  preferredModelParameters,
  speedRouteFields,
} from './model-route-utils';
import { routedExactContextTokens } from './route-editor-context';
import { contextSliderPercent, contextTokensForPercent, defaultContextPercent } from './model-controls';
import { modelContextWindow, modelDisplayName, modelFastAvailable, modelMaxContextWindow } from './provider-display';
import { RouteEditor } from './RouteEditor';

export function ModelRouteEditor({
  models,
  value,
  disabled = false,
  ariaLabel = '',
  catalogLoaded = true,
  catalogRefreshing = false,
  catalogError = '',
  providerSetupError = '',
  labelForModel,
  providerNames,
  dropdown = false,
  composerParity = false,
  autoEffortSwitch = false,
  onChange,
  onOpenProviders,
}: {
  /** Setup-derived custom provider names (customProviderDisplayNames), keyed by provider id. */
  providerNames?: Record<string, string>;
  /** Open as a dropdown under the trigger at its width (RouteEditor `dropdown`). */
  dropdown?: boolean;
  /** Show the composer picker's Context slider and Auto effort switch. */
  composerParity?: boolean;
  /** Show the Auto effort switch without the rest of the composer parity set. */
  autoEffortSwitch?: boolean;
  models: DesktopModelOption[];
  value: DesktopModelSelection;
  disabled?: boolean;
  ariaLabel?: string;
  catalogLoaded?: boolean;
  catalogRefreshing?: boolean;
  catalogError?: string;
  providerSetupError?: string;
  labelForModel?: (model: DesktopModelOption) => string;
  onChange(selection: DesktopModelSelection): unknown;
  onOpenProviders?: () => void;
}) {
  const provider = String(value.provider || '');
  const model = String(value.model || '');
  const selected = models.find((option) => option.provider === provider && option.model === model);
  const effort = selected?.effortOptions.some((option) => option.value === value.effort)
    ? String(value.effort)
    : preferredModelEffort(selected) || '';
  const modelParameters = preferredModelParameters(selected, value.modelParameters || {});
  const fastAvailable = modelFastAvailable(selected, effort, modelParameters);
  const fast = fastAvailable && (typeof value.fast === 'boolean' ? value.fast : selected?.fastPreferred === true);
  const routeAutoEffort = value.autoEffort !== false;
  let triggerModel = t('Select model');
  if (selected) {
    triggerModel = labelForModel?.(selected) || modelDisplayName(selected.model, selected.provider, selected.display);
  } else if (model && !catalogLoaded) {
    triggerModel = modelDisplayName(model, provider);
  }
  const selectionFor = (
    option: DesktopModelOption,
    patch: Partial<DesktopModelSelection> = {}
  ): DesktopModelSelection => {
    const sameModel = option === selected;
    const nextEffort = patch.effort ?? (sameModel ? effort : preferredModelEffort(option) || '');
    const nextParameters = patch.modelParameters ?? preferredModelParameters(option, sameModel ? modelParameters : {});
    const requestedFast = patch.fast ?? (sameModel ? fast : option.fastPreferred);
    const nextFast = modelFastAvailable(option, nextEffort, nextParameters) && requestedFast === true;
    const nextContextPercent = patch.contextPercent ?? (sameModel ? value.contextPercent : undefined);
    // An exact window follows its own patch; a percent patch clears it.
    const keptContextTokens = sameModel ? value.contextTokens : undefined;
    const nextContextTokens = patch.contextPercent ? patch.contextTokens : keptContextTokens;
    const nextAutoEffort = patch.autoEffort ?? (sameModel ? routeAutoEffort : (option.savedAutoEffort ?? true));
    return {
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(option.fastCapable ? { fast: nextFast } : {}),
      ...(routeAutoEffortCapable(option) ? { autoEffort: nextAutoEffort } : {}),
      ...(option.modelParameterOptions?.length ? { modelParameters: nextParameters } : {}),
      ...(nextContextPercent ? { contextPercent: nextContextPercent } : {}),
      ...(nextContextTokens ? { contextTokens: nextContextTokens } : {}),
    };
  };
  const defaultWindow = selected ? modelContextWindow(selected) : 0;
  const maxWindow = selected ? modelMaxContextWindow(selected) : 0;
  const contextVisible = composerParity && maxWindow > 0;
  const autoEffortRoute = useAutoEffortRoute(
    (composerParity || autoEffortSwitch) && selected?.autoEffortCapable === true,
    value.autoEffort,
    (enabled) => {
      if (!selected) return;
      onChange(selectionFor(selected, enabled ? { autoEffort: true } : { autoEffort: false }));
    }
  );
  const contextDefaultPercent = defaultContextPercent(defaultWindow, maxWindow);
  const contextPercent = contextVisible
    ? contextSliderPercent(Number(value.contextPercent) || contextDefaultPercent)
    : 100;
  const exactContextTokens = contextVisible
    ? routedExactContextTokens(value.contextTokens, defaultWindow, maxWindow)
    : 0;
  const contextTokens = contextVisible
    ? exactContextTokens ||
      contextTokensForPercent(contextPercent, {
        defaultPercent: contextDefaultPercent,
        defaultTokens: defaultWindow,
        maxTokens: maxWindow,
      })
    : 0;

  return (
    <RouteEditor
      models={models}
      providerNames={providerNames}
      provider={provider}
      model={model}
      triggerModel={triggerModel}
      effort={effort}
      effortOptions={selected?.effortOptions || []}
      fast={fast}
      fastVisible={selected?.fastCapable === true}
      fastAvailable={fastAvailable}
      contextVisible={contextVisible}
      contextPercent={contextPercent}
      contextDefaultPercent={contextVisible ? contextDefaultPercent : 100}
      contextTokens={contextTokens}
      contextExactTokens={exactContextTokens}
      contextMaxTokens={contextVisible ? maxWindow : 0}
      contextDefaultTokens={contextVisible ? defaultWindow : 0}
      modelParameterOptions={selected?.modelParameterOptions || []}
      modelParameters={modelParameters}
      catalogLoaded={catalogLoaded}
      catalogRefreshing={catalogRefreshing}
      catalogError={catalogError}
      providerSetupError={providerSetupError}
      modelDisabled={disabled}
      tuningDisabled={disabled}
      tooltip={ariaLabel || t('Choose model')}
      onSelectModel={(option) => onChange(selectionFor(option))}
      onChangeEffort={(nextEffort) => {
        // A picked level is explicit: it turns this route's Auto effort off.
        if (selected) onChange(selectionFor(selected, { effort: nextEffort, autoEffort: false }));
      }}
      onChangeSpeed={(speed) => {
        if (!selected) return;
        const next = speedRouteFields(speed, modelParameters, modelOffersUltrafast(selected));
        onChange(selectionFor(selected, next));
      }}
      onChangeContext={(nextPercent, nextTokens) => {
        if (selected && contextVisible) {
          onChange(selectionFor(selected, { contextPercent: nextPercent, contextTokens: nextTokens }));
        }
      }}
      onChangeModelParameter={(id, nextValue) => {
        if (!selected) return;
        onChange(
          selectionFor(selected, {
            modelParameters: { ...modelParameters, [id]: nextValue },
          })
        );
      }}
      onOpenProviders={onOpenProviders}
      autoEffort={autoEffortRoute.autoEffort}
      onChangeAutoEffort={autoEffortRoute.onChangeAutoEffort}
      onOpenSheet={autoEffortRoute.onOpenSheet}
      // A dialog/settings field: the sheet opens below it like every popup.
      placement="below"
      dropdown={dropdown}
    />
  );
}
