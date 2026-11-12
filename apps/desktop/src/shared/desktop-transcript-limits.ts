// Pieces of desktop-support.ts the phone's web bundle needs: the main module imports node:path/node:url, which a web build refuses.
import type { DesktopModelOption } from './contract';

/** First-open transcript tail for paging views: the virtual list paints about
 *  28 rows at first (a ~1080px pane at the 60px row estimate plus 10 overscan
 *  rows), so 32 items cover it; the byte budget may cut that to no fewer than
 *  8 items (enforced by the daemon) when single rows are huge, and a viewport
 *  those rows do not fill loads older history on its own. */
export const DESKTOP_TRANSCRIPT_TAIL_ITEMS = 32;
/** Serialized bytes of that remote first-open tail. A phone link uploads at
 *  22–93 KB/s (relay meter), so a 1 MB tail held the first paint 10–40 s and
 *  past the phone's 20 s call deadline; the daemon still keeps at least 8
 *  rows, and a viewport they do not fill pages older rows on its own. */
export const REMOTE_TRANSCRIPT_TAIL_BYTES = 128_000;

export function normalizedProviderModels(value: unknown): DesktopModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DesktopModelOption[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const model = typeof row.id === 'string' ? row.id.trim() : '';
    const display = [row.display, row.name, model].find(
      (candidate) => typeof candidate === 'string' && candidate.trim()
    ) as string | undefined;
    // The TUI falls back from display/name to the model id. Do the same here
    // so an otherwise selectable model from a user-configured provider is not
    // silently removed merely because its catalog omits an optional label.
    if (!provider || !model) return [];
    const effortOptions = (Array.isArray(row.effortOptions) ? row.effortOptions : []).flatMap((option) => {
      if (!option || typeof option !== 'object') return [];
      const item = option as Record<string, unknown>;
      const value = typeof item.value === 'string' ? item.value.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      return value && label ? [{ value, label }] : [];
    });
    const fastCapable = row.fastCapable === true;
    const created = Number(row.created);
    const contextWindow = Number(row.contextWindow);
    const maxContextWindow = Number(row.maxContextWindow);
    const releaseDate = typeof row.releaseDate === 'string' ? row.releaseDate.trim() : '';
    const family = typeof row.family === 'string' ? row.family.trim() : '';
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    const savedEffort =
      typeof row.savedEffort === 'string' && effortOptions.some((option) => option.value === row.savedEffort)
        ? row.savedEffort
        : undefined;
    const savedFast = typeof row.savedFast === 'boolean' ? row.savedFast : undefined;
    const savedAutoEffort = typeof row.savedAutoEffort === 'boolean' ? row.savedAutoEffort : undefined;
    const savedContextPercent = Number(row.savedContextPercent);
    const modelParameterOptions = Array.isArray(row.modelParameterOptions)
      ? (row.modelParameterOptions as DesktopModelOption['modelParameterOptions'])
      : [];
    const parameterVariants = Array.isArray(row.parameterVariants)
      ? (row.parameterVariants as Array<Record<string, string>>)
      : [];
    const defaultModelParameters =
      row.defaultModelParameters && typeof row.defaultModelParameters === 'object'
        ? (row.defaultModelParameters as Record<string, string>)
        : {};
    const savedModelParameters =
      row.savedModelParameters && typeof row.savedModelParameters === 'object'
        ? (row.savedModelParameters as Record<string, string>)
        : {};
    return [
      {
        provider,
        model,
        display: display?.trim() || model,
        ...(Number.isFinite(created) && created > 0 ? { created } : {}),
        ...(releaseDate ? { releaseDate } : {}),
        ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
        ...(Number.isFinite(maxContextWindow) && maxContextWindow > 0 ? { maxContextWindow } : {}),
        ...(family ? { family } : {}),
        ...(row.latest === true ? { latest: true } : {}),
        ...(description ? { description } : {}),
        ...(typeof row.providerName === 'string' && row.providerName.trim()
          ? { providerName: row.providerName.trim() }
          : {}),
        ...(row.supportsVision === true ? { supportsVision: true } : {}),
        effortOptions,
        fastCapable,
        fastPreferred: fastCapable && (row.fastPreferred === true || row.savedFast === true),
        ...(savedEffort ? { savedEffort } : {}),
        ...(savedFast === undefined ? {} : { savedFast }),
        ...(savedAutoEffort === undefined ? {} : { savedAutoEffort }),
        ...(Number.isFinite(savedContextPercent) && savedContextPercent >= 10 && savedContextPercent <= 100
          ? { savedContextPercent }
          : {}),
        ...(typeof row.savedHidden === 'boolean' ? { savedHidden: row.savedHidden } : {}),
        ...(row.favorite === true ? { favorite: true } : {}),
        // Marks a quick answer that already holds the full catalog (see
        // fetchProviderModels); absent everywhere else.
        ...(row.catalogComplete === true ? { catalogComplete: true as const } : {}),
        // Rows of a partial answer (a provider failed or timed out): which
        // providers are missing and when to ask again.
        ...(row.catalogPartial === true
          ? {
              catalogPartial: true as const,
              catalogMissing: Array.isArray(row.catalogMissing) ? row.catalogMissing.map(String) : [],
              ...(Number.isFinite(Number(row.catalogRetryAt)) ? { catalogRetryAt: Number(row.catalogRetryAt) } : {}),
            }
          : {}),
        ...(typeof row.defaultEffort === 'string' && row.defaultEffort ? { defaultEffort: row.defaultEffort } : {}),
        ...(row.defaultFast === true ? { defaultFast: true } : {}),
        ...(row.autoEffortCapable === true ? { autoEffortCapable: true } : {}),
        modelParameterOptions,
        parameterVariants,
        defaultModelParameters,
        savedModelParameters,
      },
    ];
  });
}
