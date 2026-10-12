import type { DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import { routeAutoEffortCapable, useAutoEffortRoute } from './auto-effort-store';
import { t } from './i18n';
import {
  modelOffersUltrafast,
  preferredModelEffort,
  preferredModelParameters,
  speedRouteFields,
} from './model-route-utils';
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
  composerParity = false,
  autoEffortSwitch = false,
  onChange,
  onOpenProviders,
}: {
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
    const nextAutoEffort =
      patch.autoEffort ?? (sameModel ? routeAutoEffort : (option.savedAutoEffort ?? true));
    return {
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(option.fastCapable ? { fast: nextFast } : {}),
      ...(routeAutoEffortCapable(option) ? { autoEffort: nextAutoEffort } : {}),
      ...(option.modelParameterOptions?.length ? { modelParameters: nextParameters } : {}),
      ...(nextContextPercent ? { contextPercent: nextContextPercent } : {}),
    };
  };
  const defaultWindow = selected ? modelContextWindow(selected) : 0;
  const maxWindow = selected ? modelMaxContextWindow(selected) : 0;
  const contextVisible = composerParity && maxWindow > 0;
  const autoEffortRoute = useAutoEffortRoute(
    (composerParity || autoEffortSwitch) && selected?.autoEffortCapable === true,
    value.autoEffort,
    (enabled) => {
      if (selected) onChange(selectionFor(selected, { autoEffort: enabled }));
    }
  );
  const contextDefaultPercent = defaultContextPercent(defaultWindow, maxWindow);
  const contextPercent = contextVisible
    ? contextSliderPercent(Number(value.contextPercent) || contextDefaultPercent)
    : 100;
  const contextTokens = contextVisible
    ? contextTokensForPercent(contextPercent, {
        defaultPercent: contextDefaultPercent,
        defaultTokens: defaultWindow,
        maxTokens: maxWindow,
      })
    : 0;

  return (
    <RouteEditor
      models={models}
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
        if (selected) onChange(selectionFor(selected, { effort: nextEffort }));
      }}
      onChangeSpeed={(speed) => {
        if (!selected) return;
        const next = speedRouteFields(speed, modelParameters, modelOffersUltrafast(selected));
        onChange(selectionFor(selected, next));
      }}
      onChangeContext={(nextPercent) => {
        if (selected && contextVisible) onChange(selectionFor(selected, { contextPercent: nextPercent }));
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
    />
  );
}
