import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { modelDisplayName } from './provider-display';
import { record } from './record-utils';
import { effortAutoField } from './route-auto-effort';

export type InheritanceFit = {
  known: boolean;
  fits: boolean;
  /** The carry compacts the conversation for the heir before moving it. */
  willCompact: boolean;
  used: number;
  limit: number;
  percent: number | null;
  provider: string;
  model: string;
  reason: string;
};

function fitNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function inheritanceFitValue(value: unknown): InheritanceFit | null {
  const row = record(value);
  if (typeof row.known !== 'boolean') return null;
  const percent = Number(row.percent);
  return {
    known: row.known,
    fits: row.fits !== false,
    willCompact: row.willCompact === true,
    used: fitNumber(row.used),
    limit: fitNumber(row.limit),
    percent: Number.isFinite(percent) ? percent : null,
    provider: String(row.provider || ''),
    model: String(row.model || ''),
    reason: String(row.reason || ''),
  };
}

export function sessionModelSelection(snapshot: Snapshot): DesktopModelSelection | null {
  const provider = String(snapshot.provider || '').trim();
  const model = String(snapshot.model || '').trim();
  if (!provider || !model) return null;
  const effort = String(snapshot.effort || '').trim();
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof snapshot.fast === 'boolean' ? { fast: snapshot.fast } : {}),
    ...effortAutoField(snapshot.effortAuto, true),
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
    ...(Number.isInteger(snapshot.contextTokens) && Number(snapshot.contextTokens) > 0
      ? { contextTokens: Number(snapshot.contextTokens) }
      : {}),
  };
}

/** The heir's own reading of this conversation, from the runtime that would perform the carry. Null when the preflight cannot run. */
export async function inheritancePreflight(
  sessionId: string,
  route: DesktopModelSelection
): Promise<InheritanceFit | null> {
  const api = window.mixdogDesktop;
  if (!sessionId || typeof api?.invokeCapability !== 'function') return null;
  try {
    const result = await api.invokeCapability({
      capability: 'inheritancePreflight',
      args: [sessionId, route],
      sessionId,
    });
    return inheritanceFitValue(record(result).value);
  } catch {
    return null;
  }
}

/** Carries a session into a fresh heir (the Inherit button and /inherit). A transcript the heir cannot hold even compacted is refused before any session exists; `compact: false` is refused when the whole conversation does not fit. Resolves true once the heir exists. */
export async function inheritSessionDirectly(
  sessionId: string,
  route: DesktopModelSelection,
  inherit: (sourceSessionId: string, route: DesktopModelSelection, options?: { compact: boolean }) => Promise<void>,
  options?: { compact: boolean }
): Promise<boolean> {
  const fit = await inheritancePreflight(sessionId, route);
  if (fit?.known && !fit.fits) {
    if (options?.compact === false) {
      showDesktopToast(
        t('This chat is long, so it can only be forked to {{model}} as a summary.', {
          model: modelDisplayName(route.model, route.provider),
        }),
        'warn'
      );
      return false;
    }
    if (!fit.willCompact) {
      showDesktopToast(t('This conversation no longer fits the model context. Run /compact first.'), 'warn');
      return false;
    }
    showDesktopToast(t('This conversation is compacted for the new model before it carries over.'), 'info');
  }
  await (options ? inherit(sessionId, route, options) : inherit(sessionId, route));
  return true;
}
