import type { DesktopModelSelection } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { record } from './record-utils';
// @ts-expect-error Shared runtime ESM intentionally has no separate declaration file.
import { displayModelName } from '../../../../src/ui/model-display.mjs';

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
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
  };
}

export function lastAssistantRoute(snapshot: Snapshot): { provider: string; model: string; modelId?: string } | null {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index]);
    if (String(item.kind || '') !== 'assistant' && !(item.kind === 'statusdone' && item.status === 'inherited'))
      continue;
    const model = String(item.model || '').trim();
    const modelId = String(item.modelId || '').trim();
    if (!model && !modelId) continue;
    return {
      provider: String(item.provider || '').trim(),
      model,
      ...(modelId ? { modelId } : {}),
    };
  }
  return null;
}

export function shouldOfferSessionInheritance(snapshot: Snapshot): boolean {
  const current = sessionModelSelection(snapshot);
  const previous = lastAssistantRoute(snapshot);
  if (!current || !previous) return false;
  if (previous.provider && current.provider.toLowerCase() !== previous.provider.toLowerCase()) return true;
  // New rows carry exact identity even when two IDs share a display name.
  if (previous.modelId) return current.model.toLowerCase() !== previous.modelId.toLowerCase();
  // Legacy rows stored either a raw ID or its display label. Reuse the
  // original formatter, not punctuation-stripping or guessed model aliases.
  const recordedModel = previous.model.toLowerCase();
  return (
    current.model.toLowerCase() !== recordedModel &&
    displayModelName(current.model, current.provider).toLowerCase() !== recordedModel
  );
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
