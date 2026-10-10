import { useEffect, useState } from 'react';
import type { RouteSheetPane } from './route-editor-logic';

/** Context slider drag preview: local until commit (pointer/key release);
 *  the routed contextPercent takes over once the snapshot catches up. */
export function useContextDraft({
  pane,
  contextPercent,
  contextDefaultPercent,
  contextTokens,
  contextMaxTokens,
  contextDefaultTokens,
  onChangeContext,
}: {
  pane: RouteSheetPane | null;
  contextPercent: number;
  contextDefaultPercent: number;
  contextTokens: number;
  contextMaxTokens: number;
  contextDefaultTokens: number;
  onChangeContext(percent: number): void;
}) {
  const [contextDraft, setContextDraft] = useState<number | null>(null);
  const shownContextPercent = contextDraft ?? contextPercent;
  let shownContextTokens = contextTokens;
  if (shownContextPercent !== contextPercent) {
    if (shownContextPercent === contextDefaultPercent && contextDefaultTokens) {
      shownContextTokens = contextDefaultTokens;
    } else if (contextMaxTokens) {
      shownContextTokens = Math.max(1, Math.floor((contextMaxTokens * shownContextPercent) / 100));
    }
  }
  const defaultContextTokens =
    contextDefaultTokens ||
    (contextMaxTokens ? Math.max(1, Math.floor((contextMaxTokens * contextDefaultPercent) / 100)) : contextTokens);
  const commitContextDraft = () => {
    if (contextDraft === null || contextDraft === contextPercent) return;
    onChangeContext(contextDraft);
  };
  useEffect(() => {
    // A closed/left pane or a snapshot that caught up releases the preview.
    if (contextDraft !== null && (pane !== 'context' || contextDraft === contextPercent)) {
      setContextDraft(null);
    }
  }, [pane, contextDraft, contextPercent]);
  return { setContextDraft, shownContextPercent, shownContextTokens, defaultContextTokens, commitContextDraft };
}
