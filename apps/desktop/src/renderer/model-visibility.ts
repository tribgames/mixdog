// Model management rules shared by the /model picker and Settings → Model
// management: which catalog models /model lists, and the card's pending edits.
import type { DesktopModelOption } from '../shared/contract';
// @ts-expect-error -- shared TUI source has no declaration file.
import { compareModelRecency, normalizeModelOptions } from '../../../../src/tui/app/model-options.mjs';
import { record } from './record-utils';

export function modelKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

const recencyRow = (option: DesktopModelOption) => ({ ...option, id: option.model });

/** The catalog deduplicated (a later row wins), providers in first-seen order,
 *  each provider's models newest first — the order /model shows. */
export function orderModelsByRecency(models: readonly DesktopModelOption[]): DesktopModelOption[] {
  const unique = new Map<string, DesktopModelOption>();
  for (const option of models) {
    if (option?.provider && option?.model) unique.set(modelKey(option.provider, option.model), option);
  }
  const providers = new Map<string, DesktopModelOption[]>();
  for (const option of unique.values()) {
    providers.set(option.provider, [...(providers.get(option.provider) || []), option]);
  }
  return [...providers.values()].flatMap((options) =>
    options
      .map((option) => ({ option, row: recencyRow(option) }))
      .sort((left, right) => compareModelRecency(left.row, right.row))
      .map(({ option }) => option)
  );
}

/** Models the per-family limit leaves out of /model by default ("auto-hidden"):
 *  listed only once the user checks them in Model management. */
export function autoHiddenModelKeys(models: readonly DesktopModelOption[]): Set<string> {
  const kept = new Set(
    (normalizeModelOptions(models.map(recencyRow)) as Array<{ provider: string; id: string }>).map((row) =>
      modelKey(row.provider, row.id)
    )
  );
  return new Set(models.map((option) => modelKey(option.provider, option.model)).filter((key) => !kept.has(key)));
}

/** A custom provider's own hidden flags (`modelOverrides[id].hidden`), keyed
 *  by provider:model. Its catalog rows carry no modelSettings visibility. */
export function customModelHiddenFlags(providerSetup: unknown): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const setup = record(providerSetup);
  for (const group of ['api', 'oauth', 'local']) {
    const entries = setup[group];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries.map(record)) {
      if (entry.custom !== true) continue;
      const provider = String(entry.id || entry.provider || '');
      for (const [model, override] of Object.entries(record(entry.modelOverrides))) {
        const hidden = record(override).hidden;
        if (typeof hidden === 'boolean') flags.set(modelKey(provider, model), hidden);
      }
    }
  }
  return flags;
}

/** The user's explicit choice for a model, or undefined for the default. */
export function explicitModelHidden(
  option: DesktopModelOption,
  customFlags: ReadonlyMap<string, boolean>
): boolean | undefined {
  return customFlags.get(modelKey(option.provider, option.model)) ?? option.savedHidden;
}

/** Whether /model lists the model: the explicit choice, else every model the
 *  family limit keeps — a model the server newly reports is listed. */
export function modelListed(
  option: DesktopModelOption,
  autoHidden: ReadonlySet<string>,
  customFlags: ReadonlyMap<string, boolean>
): boolean {
  const hidden = explicitModelHidden(option, customFlags);
  return hidden === undefined ? !autoHidden.has(modelKey(option.provider, option.model)) : !hidden;
}

/** The rows /model lists, in catalog order. `catalog` is the whole ordered
 *  catalog the family limit is measured against. */
export function listedModels(
  options: readonly DesktopModelOption[],
  catalog: readonly DesktopModelOption[],
  providerSetup: unknown
): DesktopModelOption[] {
  const autoHidden = autoHiddenModelKeys(catalog);
  const customFlags = customModelHiddenFlags(providerSetup);
  return options.filter((option) => modelListed(option, autoHidden, customFlags));
}

/** The provider card Settings → Model management opens on: set by the
 *  Providers page and the /model picker's row menu, taken once by the panel. */
let requestedProvider = '';

export function requestModelManagementProvider(provider: string): void {
  requestedProvider = provider;
}

export function takeRequestedModelManagementProvider(): string {
  const provider = requestedProvider;
  requestedProvider = '';
  return provider;
}

/** The catalog with one saved change applied, so /model reflects it before the
 *  re-read lands. */
export function applyModelPreferenceToModels(
  models: readonly DesktopModelOption[],
  provider: string,
  change: ModelPreferenceChange
): DesktopModelOption[] {
  return models.map((option) =>
    option.provider === provider && option.model === change.model
      ? {
          ...option,
          ...(change.hidden === undefined ? {} : { savedHidden: change.hidden }),
          ...(change.favorite === undefined ? {} : { favorite: change.favorite }),
        }
      : option
  );
}

/** The same for a custom provider, whose hidden flag lives in its setup entry
 *  (`modelOverrides` / `models`) rather than on the catalog row. */
export function applyModelPreferenceToSetup(
  providerSetup: unknown,
  provider: string,
  change: ModelPreferenceChange
): unknown {
  if (providerSetup == null || change.hidden === undefined) return providerSetup;
  const hidden = change.hidden;
  const setup = record(providerSetup);
  const next: Record<string, unknown> = { ...setup };
  for (const group of ['api', 'oauth', 'local']) {
    const entries = setup[group];
    if (!Array.isArray(entries)) continue;
    next[group] = entries.map((raw) => {
      const entry = record(raw);
      if (entry.custom !== true || String(entry.id || entry.provider || '') !== provider) return raw;
      return {
        ...entry,
        modelOverrides: {
          ...record(entry.modelOverrides),
          [change.model]: { ...record(record(entry.modelOverrides)[change.model]), hidden },
        },
        ...(Array.isArray(entry.models)
          ? { models: entry.models.map((row) => (record(row).id === change.model ? { ...record(row), hidden } : row)) }
          : {}),
      };
    });
  }
  return next;
}

/** One model's state in the Model management card. */
export interface ModelPreferenceState {
  shown: boolean;
  favorite: boolean;
}

export interface ModelPreferenceChange {
  model: string;
  hidden?: boolean;
  favorite?: boolean;
}

/** The pending edits of a card: only the fields that differ from the saved
 *  state, one entry per changed model. */
export function modelPreferenceChanges(
  saved: ReadonlyMap<string, ModelPreferenceState>,
  draft: ReadonlyMap<string, ModelPreferenceState>
): ModelPreferenceChange[] {
  const changes: ModelPreferenceChange[] = [];
  for (const [model, next] of draft) {
    const before = saved.get(model);
    if (!before) continue;
    const change: ModelPreferenceChange = { model };
    if (next.shown !== before.shown) change.hidden = !next.shown;
    if (next.favorite !== before.favorite) change.favorite = next.favorite;
    if (change.hidden !== undefined || change.favorite !== undefined) changes.push(change);
  }
  return changes;
}
