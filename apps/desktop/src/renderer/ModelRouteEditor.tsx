import type { DesktopModelOption, DesktopModelSelection } from '../shared/contract';
import { t } from './i18n';
import { preferredModelEffort, preferredModelParameters } from './model-route-utils';
import {
  modelDisplayName,
  modelFastAvailable,
} from './provider-display';
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
  onChange,
  onOpenProviders,
}: {
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
  const selected = models.find((option) =>
    option.provider === provider && option.model === model);
  const effort = selected?.effortOptions.some((option) => option.value === value.effort)
    ? String(value.effort)
    : preferredModelEffort(selected) || '';
  const modelParameters = preferredModelParameters(selected, value.modelParameters || {});
  const fastAvailable = modelFastAvailable(selected, effort, modelParameters);
  const fast = fastAvailable && (typeof value.fast === 'boolean'
    ? value.fast
    : selected?.fastPreferred === true);
  const triggerModel = selected
    ? labelForModel?.(selected) || modelDisplayName(selected.model, selected.provider, selected.display)
    : model && !catalogLoaded ? modelDisplayName(model, provider) : t('Select model');
  const selectionFor = (
    option: DesktopModelOption,
    patch: Partial<DesktopModelSelection> = {},
  ): DesktopModelSelection => {
    const sameModel = option === selected;
    const nextEffort = patch.effort ?? (sameModel ? effort : preferredModelEffort(option) || '');
    const nextParameters = patch.modelParameters
      ?? preferredModelParameters(option, sameModel ? modelParameters : {});
    const requestedFast = patch.fast ?? (sameModel ? fast : option.fastPreferred);
    const nextFast = modelFastAvailable(option, nextEffort, nextParameters) && requestedFast === true;
    return {
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(option.fastCapable ? { fast: nextFast } : {}),
      ...(option.modelParameterOptions?.length ? { modelParameters: nextParameters } : {}),
      ...(value.contextPercent ? { contextPercent: value.contextPercent } : {}),
    };
  };

  return <RouteEditor models={models} provider={provider} model={model}
    triggerModel={triggerModel} effort={effort}
    effortOptions={selected?.effortOptions || []}
    fast={fast} fastVisible={selected?.fastCapable === true} fastAvailable={fastAvailable}
    contextVisible={false} contextPercent={100} contextDefaultPercent={100}
    contextTokens={0} contextMaxTokens={0} contextDefaultTokens={0}
    modelParameterOptions={selected?.modelParameterOptions || []}
    modelParameters={modelParameters}
    catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
    catalogError={catalogError} providerSetupError={providerSetupError}
    modelDisabled={disabled} tuningDisabled={disabled}
    tooltip={ariaLabel || t('Choose model')}
    onSelectModel={(option) => onChange(selectionFor(option))}
    onChangeEffort={(nextEffort) => {
      if (selected) onChange(selectionFor(selected, { effort: nextEffort }));
    }}
    onChangeFast={(nextFast) => {
      if (selected) onChange(selectionFor(selected, { fast: nextFast }));
    }}
    onChangeContext={() => {}}
    onChangeModelParameter={(id, nextValue) => {
      if (!selected) return;
      onChange(selectionFor(selected, {
        modelParameters: { ...modelParameters, [id]: nextValue },
      }));
    }}
    onOpenProviders={onOpenProviders} />;
}
