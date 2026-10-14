/**
 * Tool-result text for the page-reading actions: `annotate` marks and
 * `inspect` readings, one entry per HTML pane.
 */
import { formatPageInspection, visualizePageInspection } from '../../shared/visualize-inspect';
import type { VisualizeOverlayResult } from './overlay-script';

const markLine = (mark: VisualizeOverlayResult['marks'][number]): string => {
  const label = mark.label ? ` "${mark.label}"` : '';
  const plural = mark.count === 1 ? '' : 'es';
  return `${mark.selector}${label} → ${mark.count} match${plural}`;
};

/** One line per pane: its marks and any invalid selectors. */
export function annotationLines(results: Array<{ pane: string; result: VisualizeOverlayResult }>): string[] {
  return results.map(({ pane, result }) => {
    const marks = result.marks.length ? result.marks.map(markLine).join('; ') : 'no marks';
    const invalid = result.invalid.length ? ` · invalid selector(s): ${result.invalid.join(', ')}` : '';
    return `${pane}: ${marks}${invalid}`;
  });
}

/** One section per pane: its reading, error, or the lack of one. */
export function inspectionSections(answers: Array<{ pane: string; result: unknown }>): string[] {
  return answers.map(({ pane, result }) => {
    const parsed = visualizePageInspection(result);
    if (!parsed) return `${pane}: the page returned no reading`;
    if ('error' in parsed) return `${pane}: ${parsed.error}`;
    return formatPageInspection(parsed, pane);
  });
}
