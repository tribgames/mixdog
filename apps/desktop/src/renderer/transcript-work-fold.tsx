import { ChevronRight } from 'lucide-react';
import React, { useMemo } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { desktopToolActivityCallCounts, desktopToolActivitySummary } from './transcript-tool-core';
import { toggleWorkFold } from './use-turn-work-folds';

/** The label of a finished turn's folded work: its steps, its tool calls and,
 *  only when some failed, how many. The turn's time stays on its footer. */
export function workFoldLabel(steps: number, items: readonly TranscriptItem[]): string {
  const { calls, failed } = desktopToolActivityCallCounts(items);
  const parts = [t('{{count}} steps', { count: steps }), t('Used tools {{count}} times', { count: calls })];
  if (failed > 0) parts.push(t('{{count}} failed', { count: failed }));
  return parts.join(' · ');
}

/** One row standing for a finished turn's work above its final answer; it
 *  opens the work in place (use-turn-work-folds.ts). */
export const WorkFoldRow = React.memo(function WorkFoldRow({
  foldKey,
  steps,
  items,
  open,
}: {
  foldKey: string;
  steps: number;
  items: readonly TranscriptItem[];
  open: boolean;
}) {
  const label = useMemo(() => workFoldLabel(steps, items), [steps, items]);
  const summary = useMemo(() => desktopToolActivitySummary(items, true), [items]);
  return (
    <button
      type="button"
      className="transcript-work-fold"
      // Like a tool group's header: a press here is no reader scroll gesture.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => toggleWorkFold(foldKey)}
      aria-expanded={open}
      title={summary || undefined}
    >
      <span className="transcript-work-fold-label">{label}</span>
      <span className="transcript-work-fold-chevron" aria-hidden="true">
        <ChevronRight size={14} />
      </span>
    </button>
  );
});
