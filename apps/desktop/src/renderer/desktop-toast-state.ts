import type { Toast } from "./desktop-types";
// @ts-expect-error Shared runtime module is plain ESM.
import { describeError, safeErrorDetails } from "../../../../src/runtime/shared/error-presentation.mjs";

export type ToastRecord = {
  id: string; group: string; tone: string; text: string; details: string[];
  count: number; source: "host" | "renderer"; stateful: boolean; dismissed: boolean;
};
export type ToastGroup = {
  key: string; tone: string; text: string; details: string[]; count: number; ids: string[];
};
export type ToastAction =
  | { type: "host"; toasts: readonly Toast[] }
  | { type: "receive"; toast: Toast }
  | { type: "dismiss"; ids: readonly string[] };

function recordOf(toast: Toast, source: ToastRecord["source"]): ToastRecord | null {
  if (toast.owner === "transcript") return null;
  const text = safeErrorDetails(toast.text || toast.message || "");
  if (!text) return null;
  const tone = String(toast.tone || "info").toLowerCase();
  const identity = tone === "error" ? describeError(text).fingerprint : text;
  return {
    id: `${source}:${String(toast.id ?? `${tone}:${text}`)}`,
    group: `${tone}:${String(toast.scope || "")}:${String(toast.groupKey || identity)}`,
    tone, text, details: [text], count: 1, source,
    stateful: toast.lifetime === "state", dismissed: false,
  };
}

function receive(records: readonly ToastRecord[], next: ToastRecord): ToastRecord[] {
  const previous = records.find((record) => record.id === next.id);
  if (previous?.text === next.text && previous.group === next.group
    && previous.stateful === next.stateful) return records as ToastRecord[];
  return [...records.filter((record) => record.id !== next.id), {
    ...next,
    count: previous && previous.group === next.group ? previous.count + 1 : 1,
    details: previous && previous.group === next.group ? [...previous.details, next.text].slice(-20) : next.details,
  }].slice(-80);
}

export function reduceToasts(records: readonly ToastRecord[], action: ToastAction): ToastRecord[] {
  if (action.type === "dismiss") {
    const ids = new Set(action.ids);
    return records.map((record) => ids.has(record.id) ? { ...record, dismissed: true } : record);
  }
  if (action.type === "receive") {
    const next = recordOf(action.toast, "renderer");
    return next ? receive(records, next) : records as ToastRecord[];
  }
  const incoming = action.toasts.map((toast) => recordOf(toast, "host"))
    .filter((record): record is ToastRecord => Boolean(record));
  const activeIds = new Set(incoming.map((record) => record.id));
  let next = records.filter((record) => record.source !== "host" || !record.stateful || activeIds.has(record.id));
  for (const record of incoming) next = receive(next, record);
  return next;
}

export function groupToasts(records: readonly ToastRecord[]): ToastGroup[] {
  const groups = new Map<string, ToastGroup>();
  for (const record of records) {
    if (record.dismissed) continue;
    const previous = groups.get(record.group);
    groups.delete(record.group);
    groups.set(record.group, {
      key: record.group, tone: record.tone, text: record.text,
      count: (previous?.count || 0) + record.count,
      details: [...(previous?.details || []), ...record.details].slice(-20),
      ids: [...(previous?.ids || []), record.id],
    });
  }
  return [...groups.values()].slice(-5);
}
