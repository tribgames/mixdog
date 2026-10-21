import { useEffect, useState } from 'react';
import type { RouteSheetPane } from './route-editor-logic';

const CONTEXT_STOPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** "500", "500k" and "0.5m" → tokens; bare numbers and "k" are thousands. */
export function parseContextTokensInput(text: string): number | null {
  const match = /^(\d+(?:\.\d*)?|\.\d+)\s*([km]?)$/.exec(String(text).trim().toLowerCase().replace(/,/g, ''));
  if (!match) return null;
  const n = Number(match[1]);
  return match[2] === 'm' ? n * 1e6 : n * 1e3;
}

/** Clamp to [10% of max, max], rounded to 1000. */
export function clampContextTokens(tokens: number, maxTokens: number): number {
  const min = Math.ceil((maxTokens * 0.1) / 1000) * 1000;
  return Math.min(maxTokens, Math.max(min, Math.round(tokens / 1000) * 1000));
}

/** The exact ratio of a window to the model's max, one decimal. */
export function exactContextPercent(tokens: number, maxTokens: number): number {
  return Math.round((tokens / maxTokens) * 1000) / 10;
}

/** A route's exact window when it is a real non-default value within the
 *  model's max; 0 otherwise (the 10% stop / default governs). */
export function routedExactContextTokens(value: unknown, defaultTokens: number, maxTokens: number): number {
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 1 || !(maxTokens > 0)) return 0;
  return tokens === defaultTokens ? 0 : Math.min(tokens, maxTokens);
}

/** The route change an applied token count means: the default window or a
 *  10% stop carries no exact tokens; anything else keeps them. */
export function contextTokensChange(
  tokens: number,
  window: { defaultPercent: number; defaultTokens: number; maxTokens: number }
): { percent: number; tokens?: number } {
  if (tokens === window.defaultTokens) return { percent: window.defaultPercent };
  const stop = CONTEXT_STOPS.find(
    (percent) => percent !== window.defaultPercent && Math.floor((window.maxTokens * percent) / 100) === tokens
  );
  if (stop) return { percent: stop };
  const nearest = Math.max(10, Math.min(100, Math.round((tokens / window.maxTokens) * 10) * 10));
  return { percent: nearest, tokens };
}

/** Context slider drag preview: local until commit (pointer/key release);
 *  the routed contextPercent takes over once the snapshot catches up.
 *  `contextExactTokens` (0 = none) is a routed exact window that overrides
 *  the 10% stop. */
export function useContextDraft({
  pane,
  contextPercent,
  contextDefaultPercent,
  contextTokens,
  contextExactTokens = 0,
  contextMaxTokens,
  contextDefaultTokens,
  onChangeContext,
}: {
  pane: RouteSheetPane | null;
  contextPercent: number;
  contextDefaultPercent: number;
  contextTokens: number;
  contextExactTokens?: number;
  contextMaxTokens: number;
  contextDefaultTokens: number;
  onChangeContext(percent: number, tokens?: number): void;
}) {
  const [contextDraft, setContextDraft] = useState<number | null>(null);
  const exactActive = contextDraft === null && contextExactTokens > 0 && contextMaxTokens > 0;
  const shownContextPercent = exactActive
    ? exactContextPercent(contextExactTokens, contextMaxTokens)
    : (contextDraft ?? contextPercent);
  let shownContextTokens = contextTokens;
  if (contextDraft !== null) {
    if (contextDraft === contextDefaultPercent && contextDefaultTokens) {
      shownContextTokens = contextDefaultTokens;
    } else if (contextMaxTokens) {
      shownContextTokens = Math.max(1, Math.floor((contextMaxTokens * contextDraft) / 100));
    }
  }
  const defaultContextTokens =
    contextDefaultTokens ||
    (contextMaxTokens ? Math.max(1, Math.floor((contextMaxTokens * contextDefaultPercent) / 100)) : contextTokens);
  const commitContextDraft = () => {
    if (contextDraft === null || (contextDraft === contextPercent && !contextExactTokens)) return;
    onChangeContext(contextDraft);
  };
  const applyContextTokens = (tokens: number) => {
    const change = contextTokensChange(tokens, {
      defaultPercent: contextDefaultPercent,
      defaultTokens: defaultContextTokens,
      maxTokens: contextMaxTokens,
    });
    setContextDraft(null);
    if (change.tokens === (contextExactTokens || undefined) && change.percent === contextPercent) return;
    onChangeContext(change.percent, change.tokens);
  };
  const resetContextDefault = () => {
    setContextDraft(null);
    onChangeContext(contextDefaultPercent);
  };
  useEffect(() => {
    // A closed/left pane or a snapshot that caught up releases the preview.
    if (contextDraft !== null && (pane !== 'context' || (contextDraft === contextPercent && !contextExactTokens))) {
      setContextDraft(null);
    }
  }, [pane, contextDraft, contextPercent, contextExactTokens]);
  return {
    setContextDraft,
    shownContextPercent,
    shownContextTokens,
    defaultContextTokens,
    commitContextDraft,
    applyContextTokens,
    resetContextDefault,
    contextCustom: exactActive,
  };
}
