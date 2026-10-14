import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { showDesktopToast } from './notifications';
import { modelDisplayName } from './provider-display';
import { record } from './record-utils';

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
    ...(typeof snapshot.autoEffort === 'boolean' ? { autoEffort: snapshot.autoEffort } : {}),
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
    ...(Number.isInteger(snapshot.contextTokens) && Number(snapshot.contextTokens) > 0
      ? { contextTokens: Number(snapshot.contextTokens) }
      : {}),
  };
}

/**
 * The heir's OWN reading of this conversation, answered by the runtime that
 * would perform the carry.
 *
 * A session's context gauge measures something else entirely: its own
 * provider's billed prompt against its own model's boundary. Offering or
 * refusing inheritance from that number let a session sitting at 87% be
 * rejected for needing 853k tokens on the model it was being carried to. The
 * decision therefore always comes from here.
 *
 * A preflight that cannot run returns null — a missing reading is not a
 * refusal, and the runtime guard still owns the final verdict.
 */
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

/**
 * The carry itself, shared by the context card's Inherit button and /inherit:
 * no confirmation dialog — inheritance is a mechanical copy into a fresh
 * session and the source stays untouched. A transcript the heir cannot hold
 * even after compaction is refused before any session is created; one that
 * must be compacted first is announced, since the handover then takes a
 * while. An explicit whole carry (`compact: false`) never turns into a
 * summary: it is refused when the whole conversation does not fit. Resolves
 * true once the heir exists.
 */
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
