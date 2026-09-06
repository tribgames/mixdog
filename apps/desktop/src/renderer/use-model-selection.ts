import { useEffect, useRef, useState } from "react";
import type { DesktopModelSelection, SessionSnapshot } from "../shared/contract";
import { mergeRoutePreference } from "./app-route-preference";

type PendingSelection = {
  token: number;
  sessionId: string;
  selection: DesktopModelSelection;
  settled: boolean;
};

function sameSelection(left: DesktopModelSelection, right: DesktopModelSelection): boolean {
  if (left.provider !== right.provider || left.model !== right.model
    || (left.effort || "") !== (right.effort || "")
    || Boolean(left.fast) !== Boolean(right.fast)
    || left.contextPercent !== right.contextPercent) return false;
  const before = left.modelParameters || {};
  const after = right.modelParameters || {};
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every((key) => before[key] === after[key]);
}

function acknowledgedSelection(
  requested: DesktopModelSelection,
  snapshot: NonNullable<SessionSnapshot>,
): DesktopModelSelection {
  const value = snapshot as Record<string, unknown>;
  return {
    ...requested,
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(Object.hasOwn(value, "effort")
      ? { effort: typeof value.effort === "string" ? value.effort : "" }
      : {}),
    ...(typeof value.fast === "boolean" ? { fast: value.fast } : {}),
    ...(Object.hasOwn(value, "contextPercent")
      ? { contextPercent: typeof value.contextPercent === "number" ? value.contextPercent : undefined }
      : {}),
    ...(value.modelParameters && typeof value.modelParameters === "object"
      ? { modelParameters: value.modelParameters as Record<string, string> }
      : {}),
  };
}

// A mutation owns its preview through BOTH the reply and the React snapshot
// handoff. Streaming old props are not a rejection; only a failed mutation is.
export function useModelSelection(sessionId: string, authoritative: DesktopModelSelection) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const sequence = useRef(0);
  const active = pending?.sessionId === sessionId ? pending : null;
  const selection = active?.selection || authoritative;
  useEffect(() => {
    if (pending && (pending.sessionId !== sessionId
      || (pending.settled && sameSelection(authoritative, pending.selection)))) {
      setPending(null);
    }
  }, [authoritative, pending, sessionId]);
  return {
    selection,
    pending: active !== null,
    begin(next: DesktopModelSelection) {
      const token = ++sequence.current;
      setPending({
        token,
        sessionId,
        selection: mergeRoutePreference(selection, next),
        settled: false,
      });
      return token;
    },
    settle(token: number, snapshot?: SessionSnapshot | null) {
      setPending((current) => {
        if (!current || current.token !== token || current.sessionId !== sessionId) return current;
        if (!snapshot) return null;
        return {
          ...current,
          selection: acknowledgedSelection(current.selection, snapshot),
          settled: true,
        };
      });
    },
  };
}
