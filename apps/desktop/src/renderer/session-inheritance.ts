import type { DesktopModelSelection } from "../shared/contract";
import type { Snapshot } from "./desktop-types";
import { record } from "./record-utils";
// @ts-expect-error Shared runtime ESM intentionally has no separate declaration file.
import { displayModelName } from "../../../../src/ui/model-display.mjs";

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const number = finite(value);
    if (number !== null) return number;
  }
  return null;
}

export function sessionModelSelection(snapshot: Snapshot): DesktopModelSelection | null {
  const provider = String(snapshot.provider || "").trim();
  const model = String(snapshot.model || "").trim();
  if (!provider || !model) return null;
  const effort = String(snapshot.effort || "").trim();
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof snapshot.fast === "boolean" ? { fast: snapshot.fast } : {}),
    ...(snapshot.modelParameters ? { modelParameters: { ...snapshot.modelParameters } } : {}),
    ...(Number(snapshot.contextPercent) >= 10 ? { contextPercent: Number(snapshot.contextPercent) } : {}),
  };
}

export function lastAssistantRoute(snapshot: Snapshot): { provider: string; model: string; modelId?: string } | null {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index]);
    if (String(item.kind || "") !== "assistant"
      && !(item.kind === "statusdone" && item.status === "inherited")) continue;
    const model = String(item.model || "").trim();
    const modelId = String(item.modelId || "").trim();
    if (!model && !modelId) continue;
    return {
      provider: String(item.provider || "").trim(),
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
  return current.model.toLowerCase() !== recordedModel
    && displayModelName(current.model, current.provider).toLowerCase() !== recordedModel;
}

export function inheritanceContextFit(status: unknown, snapshot: Snapshot) {
  const context = record(status);
  const compaction = record(context.compaction);
  const stats = record(snapshot.stats);
  const used = firstFinite(
    compaction.pressureTokens,
    compaction.currentEstimatedTokens,
    context.usedTokens,
    context.currentEstimatedTokens,
    stats.currentEstimatedContextTokens,
    stats.currentContextTokens,
  );
  const limit = firstFinite(
    compaction.triggerTokens,
    snapshot.autoCompactTokenLimit,
    context.contextWindow,
    snapshot.displayContextWindow,
    snapshot.contextWindow,
  );
  const known = used !== null && limit !== null && limit > 0;
  const percent = known ? Math.max(0, Math.ceil((used / limit) * 100)) : null;
  return {
    known,
    fits: !known || used < limit,
    used: used ?? 0,
    limit: limit ?? 0,
    percent,
  };
}
