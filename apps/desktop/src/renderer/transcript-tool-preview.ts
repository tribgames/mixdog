import { capPatchLines } from './renderer-logic.mjs';
import type { desktopToolActivityItemPresentation } from './transcript-tool-model';

export type ToolActivityPresentation = ReturnType<typeof desktopToolActivityItemPresentation>;

const TOOL_ACTIVITY_MARKDOWN_HINT = /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|\n\s*\|[^\n]*\|\s*(?:\n|$)/;
const TOOL_ACTIVITY_MARKDOWN_MAX = 20_000;

export function toolActivityLooksMarkdown(text: string): boolean {
  return text.length <= TOOL_ACTIVITY_MARKDOWN_MAX && TOOL_ACTIVITY_MARKDOWN_HINT.test(text);
}

const PREVIEW_OUTPUT_LINES = 5;

export type ToolActivityPreviewMode = 'lines' | 'height';

/** A preview cuts a command run or plain text output by lines; anything else
 *  (files, code, diffs, rendered answers) by height. */
export function toolActivityPreviewMode(presentation: ToolActivityPresentation): ToolActivityPreviewMode {
  const plainOutput =
    !presentation.entries.length &&
    !presentation.outputLanguage &&
    (presentation.outputLiteral || !toolActivityLooksMarkdown(presentation.outputText));
  const onlyText =
    !presentation.diffPatch &&
    !presentation.sections.length &&
    !presentation.structuredRows.length &&
    !presentation.promptText &&
    !presentation.beforeText &&
    !presentation.afterText &&
    !presentation.targets.length &&
    (presentation.fieldsInline || !presentation.fields.length);
  return onlyText && (presentation.command || plainOutput) ? 'lines' : 'height';
}

/** The first lines of an output and how many it hides. A single hidden line
 *  is shown instead of being counted. */
export function previewOutputLines(text: string): { text: string; hidden: number } {
  // Scanned, not split: an expanded card re-renders with the whole output, and splitting a large one built an array of
  // every line each render only to keep the first few.
  let end = -1;
  for (let line = 0; line < PREVIEW_OUTPUT_LINES; line++) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return { text, hidden: 0 };
  }
  let total = PREVIEW_OUTPUT_LINES + 1;
  for (let at = text.indexOf('\n', end + 1); at >= 0; at = text.indexOf('\n', at + 1)) total += 1;
  if (total <= PREVIEW_OUTPUT_LINES + 1) return { text, hidden: 0 };
  return { text: text.slice(0, end), hidden: total - PREVIEW_OUTPUT_LINES };
}

// The height clamp shows about six lines (6 × line + 16px); twice that always
// overfills it, so what is cut here is never visible.
const PREVIEW_HEIGHT_LINES = 12;

/** The first `max` lines of a text without splitting all of it. */
function capLines(text: string, max = PREVIEW_HEIGHT_LINES): { text: string; cut: boolean } {
  let end = -1;
  for (let line = 0; line < max; line++) {
    end = text.indexOf('\n', end + 1);
    if (end < 0) return { text, cut: false };
  }
  return { text: text.slice(0, end), cut: true };
}

/** A height-clamped preview's input, bounded to what the clamp can show. */
export function capPresentation(presentation: ToolActivityPresentation): {
  view: ToolActivityPresentation;
  cut: boolean;
} {
  let cut = false;
  const lines = (text: string) => {
    const capped = capLines(text);
    cut ||= capped.cut;
    return capped.text;
  };
  const rowsBudget = <T>(list: readonly T[]) => {
    cut ||= list.length > PREVIEW_HEIGHT_LINES;
    return list.slice(0, PREVIEW_HEIGHT_LINES);
  };
  let budget = PREVIEW_HEIGHT_LINES;
  const sections: typeof presentation.sections = [];
  for (const section of presentation.sections) {
    if (budget <= 0) {
      cut = true;
      break;
    }
    const rows = section.rows.slice(0, budget);
    cut ||= rows.length < section.rows.length;
    budget -= rows.length;
    sections.push(rows.length < section.rows.length ? { ...section, rows } : section);
  }
  const view = {
    ...presentation,
    outputText: lines(presentation.outputText),
    promptText: lines(presentation.promptText),
    beforeText: lines(presentation.beforeText),
    afterText: lines(presentation.afterText),
    diffPatch: presentation.diffPatch
      ? (() => {
          const capped = capPatchLines(presentation.diffPatch, PREVIEW_HEIGHT_LINES);
          cut ||= capped.cut;
          return capped.text;
        })()
      : presentation.diffPatch,
    entries: rowsBudget(presentation.entries),
    structuredRows: rowsBudget(presentation.structuredRows),
    sections,
  };
  return { view, cut };
}
