import type { DesktopModelSelection } from "../shared/contract";
import type { Snapshot } from "./desktop-types";
import { record } from "./record-utils";

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

export function lastAssistantRoute(snapshot: Snapshot): { provider: string; model: string } | null {
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index]);
    if (String(item.kind || "") !== "assistant") continue;
    const model = String(item.model || "").trim();
    if (!model) continue;
    return {
      provider: String(item.provider || "").trim(),
      model,
    };
  }
  return null;
}

export function shouldOfferSessionInheritance(snapshot: Snapshot): boolean {
  const current = sessionModelSelection(snapshot);
  const previous = lastAssistantRoute(snapshot);
  if (!current || !previous) return false;
  if (current.model.toLowerCase() !== previous.model.toLowerCase()) return true;
  return Boolean(previous.provider)
    && current.provider.toLowerCase() !== previous.provider.toLowerCase();
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
