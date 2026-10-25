/**
 * The agent's page-reading actions on a displayed tab — `annotate`,
 * `capture`, `check`, `inspect` — and the panel's source view of a pane.
 */
import { writeFile } from 'node:fs/promises';

import type { VisualizePaneText } from '../../shared/visualize';
import { inspectFindingsSummary, visualizePageInspection } from '../../shared/visualize-inspect';
import type { VisualizeServiceContext } from './context';
import { readPaneSource } from './pane-source';
import { PROBLEM_SETTLE_ROUNDS } from './problem-tracker';
import { annotationLines, inspectionSections } from './result-text';
import { applyVisualizeAnnotationOp } from '../../shared/visualize-annotations';
import {
  currentAnnotations,
  displayedPanes,
  problemRootsOf,
  problemsOf,
  shownLayout,
  summary,
  type TabState,
  type VisualizeResult,
  view,
  withProblems,
} from './tab-state';
import { resolveCaptureOutput, type VisualizeRequest } from './targets';
import { OFFSCREEN_VIEWPORT } from './export-render';
import { heldTurn, offscreenTabPng } from './turn-hold';

type ReadContext = Pick<VisualizeServiceContext, 'deps' | 'tabs' | 'problems' | 'publish' | 'holds' | 'panelSize'>;

/** The size an off-screen read lays pages out at: an explicit `viewport`, else
 *  the side panel's last measured size, else the default (`panel`: whether the
 *  panel's size was used). */
function offscreenSize(
  ctx: Pick<ReadContext, 'panelSize'>,
  viewport: { width: number; height: number } | undefined
): { size: { width: number; height: number }; panel: boolean } {
  if (viewport) return { size: viewport, panel: false };
  const known = ctx.panelSize.current;
  return known ? { size: known, panel: true } : { size: OFFSCREEN_VIEWPORT, panel: false };
}

/** Marks elements of an HTML tab; the marks live in the tab state. */
async function annotateTab(
  ctx: ReadContext,
  request: Extract<VisualizeRequest, { action: 'annotate' }>
): Promise<VisualizeResult> {
  const tab = ctx.tabs.findTab(request.sessionId, request.tab);
  if (tab.url || !tab.panes.some((pane) => pane.kind === 'html')) {
    throw new Error(`annotate works on HTML tabs only; tab ${tab.id} shows no HTML page`);
  }
  // During an agent turn the panel is left alone: the marks are kept in
  // the tab state and drawn when the turn's end shows the tab.
  const held = heldTurn(ctx, request.sessionId) !== null;
  if (!held) await ctx.tabs.display(request.sessionId, tab);
  // The marks live in the tab state: the desktop window draws them from
  // there (below), every paired device from the published state.
  const htmlPanes = displayedPanes(tab).flatMap((pane, index) => (pane.kind === 'html' ? [index] : []));
  let marks = applyVisualizeAnnotationOp(currentAnnotations(tab), request.op, htmlPanes);
  const results = held ? null : await ctx.deps.annotate(request.sessionId, view(tab), marks);
  // A selector the page's own parser refused is no mark anywhere.
  const invalid = new Set((results ?? []).flatMap(({ result }) => result.invalid));
  if (invalid.size) marks = marks.filter((mark) => !invalid.has(mark.selector));
  tab.annotations = { revision: tab.revision, marks };
  ctx.publish(request.sessionId);
  // Only a paired device shows the tab: it draws the marks; no counts here.
  const named = [...new Set(marks.map((mark) => (mark.label ? `${mark.selector} "${mark.label}"` : mark.selector)))];
  let lines: string[];
  if (results) lines = annotationLines(results);
  else if (held) {
    lines = [
      `${named.join('; ') || 'no marks'} (drawn when the side panel shows the tab at the end of this turn; not checked against the page)`,
    ];
  } else {
    lines = [
      `${named.join('; ') || 'no marks'} (drawn on the paired device showing the tab; not checked against the page here)`,
    ];
  }
  return {
    text: withProblems(tab, [`Annotations on tab ${tab.id} (cleared when the page reloads):`, ...lines].join('\n')),
    tabs: [summary(tab)],
    ...problemsOf(tab),
  };
}

/** Every HTML page of the tab read in a hidden window (an agent turn
 *  leaves the panel alone): the pages' inspections and load problems. */
async function readPagesOffscreen(
  { deps }: Pick<ReadContext, 'deps'>,
  cwd: string,
  tab: TabState,
  options: { viewport?: { width: number; height: number }; selector?: string }
): Promise<{ answers: Array<{ pane: string; result: unknown }>; problems: string[] }> {
  if (!deps.inspectOffscreen) throw new Error('reading a page off screen is unavailable here');
  const pages = displayedPanes(tab).filter((pane) => pane.kind === 'html');
  const answers: Array<{ pane: string; result: unknown }> = [];
  const problems: string[] = [];
  for (const pane of pages) {
    const read = await deps.inspectOffscreen(pane, tab.allowNetwork === true, {
      ...options,
      roots: [cwd, ...problemRootsOf(tab)],
    });
    answers.push({ pane: pane.label, result: read.result });
    problems.push(...read.problems.map((line) => (pages.length > 1 ? `${pane.label}: ${line}` : line)));
  }
  return { answers, problems };
}

/** A tab checked without the panel (an agent turn leaves it alone): pages
 *  load in a hidden window (their load problems and layout findings), inline
 *  content renders off screen (a failed render is the problem). */
export async function checkTabOffscreen(
  ctx: Pick<ReadContext, 'deps' | 'panelSize'>,
  sessionId: string,
  cwd: string,
  tab: TabState
): Promise<{
  problems: string[];
  findings: number;
  size: { width: number; height: number };
  panel: boolean;
}> {
  const { deps } = ctx;
  const { size, panel } = offscreenSize(ctx, undefined);
  const read = await readPagesOffscreen(ctx, cwd, tab, { viewport: size });
  const problems = [...read.problems];
  const findings = read.answers.reduce((sum, { result }) => {
    const parsed = visualizePageInspection(result);
    return parsed && !('error' in parsed) ? sum + parsed.findingCount : sum;
  }, 0);
  for (const pane of displayedPanes(tab)) {
    if (pane.kind !== 'inline' || !deps.exportBytes) continue;
    try {
      await deps.exportBytes(sessionId, { ...view(tab), panes: [pane] }, 'png', 0, ['']);
    } catch (error) {
      problems.push(`render failed: ${(error as Error).message}`);
    }
  }
  return { problems, findings, size, panel };
}

/** Reads a displayed HTML tab's elements and layout findings. */
async function inspectTab(
  ctx: ReadContext,
  request: Extract<VisualizeRequest, { action: 'inspect' }>
): Promise<VisualizeResult> {
  const { deps } = ctx;
  const tab = ctx.tabs.findTab(request.sessionId, request.tab);
  if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; read it with the browser tool`);
  const panes = displayedPanes(tab);
  if (!panes.some((pane) => pane.kind === 'html')) {
    const staticKind = panes.find((pane) => pane.inline)?.inline?.kind;
    throw new Error(
      staticKind
        ? `inspect reads pages with a layout; tab ${tab.id} shows static ${staticKind} content, which has no elements to read (use capture to look at it)`
        : `inspect works on HTML tabs only; tab ${tab.id} shows no HTML page`
    );
  }
  const options = {
    ...(request.viewport ? { viewport: request.viewport } : {}),
    ...(request.selector ? { selector: request.selector } : {}),
  };
  if (heldTurn(ctx, request.sessionId)) {
    // During an agent turn: each page is read in a hidden window instead.
    const { size, panel } = offscreenSize(ctx, request.viewport);
    const read = await readPagesOffscreen(ctx, request.cwd, tab, { ...options, viewport: size });
    const problems = read.problems.length
      ? `\nPage problems while it loaded:\n${read.problems.map((line) => `- ${line}`).join('\n')}`
      : '';
    return {
      text: `Inspection of tab ${tab.id}, laid out off screen at ${panel ? "the side panel's width " : ''}${size.width}×${size.height} (the side panel shows the tab when this turn ends):\n${inspectionSections(read.answers).join('\n\n')}${problems}`,
      tabs: [summary(tab)],
    };
  }
  if (!deps.inspect) throw new Error('inspect is unavailable here');
  await ctx.tabs.display(request.sessionId, tab);
  await ctx.problems.awaitInlineRender(tab);
  // The reader checks the tab is on screen itself (and says when only a
  // remote device shows it); page problems are captured while it is.
  const answers = await deps.inspect(request.sessionId, view(tab), options);
  await ctx.problems.settle(tab, 2);
  const sections = inspectionSections(answers);
  return {
    text: withProblems(
      tab,
      `Inspection of tab ${tab.id}${request.viewport ? ` at ${request.viewport.width}×${request.viewport.height}` : ''}:\n${sections.join('\n\n')}`
    ),
    tabs: [summary(tab)],
    ...problemsOf(tab),
  };
}

export function createReadActions(ctx: ReadContext) {
  const { deps } = ctx;

  /** Layout findings on the displayed pages (0 when they cannot be read:
   *  `check` stays about runtime problems). */
  async function layoutFindingCount(sessionId: string, tab: TabState): Promise<number> {
    if (!deps.inspect || !displayedPanes(tab).some((pane) => pane.kind === 'html')) return 0;
    try {
      const answers = await deps.inspect(sessionId, view(tab), {});
      return answers.reduce((sum, { result }) => {
        const parsed = visualizePageInspection(result);
        return parsed && !('error' in parsed) ? sum + parsed.findingCount : sum;
      }, 0);
    } catch {
      return 0;
    }
  }

  /** `check` during an agent turn (see `checkTabOffscreen`). */
  async function checkOffscreen(
    request: Extract<VisualizeRequest, { action: 'check' }>,
    tab: TabState
  ): Promise<VisualizeResult> {
    const { problems, findings, size, panel } = await checkTabOffscreen(ctx, request.sessionId, request.cwd, tab);
    const where = `checked off screen${panel ? ` at the side panel's width ${size.width}×${size.height}` : ''}; the side panel shows the tab when this turn ends`;
    const summaryLine = inspectFindingsSummary(findings);
    return {
      text:
        (problems.length
          ? `Checked tab ${tab.id} (${where}). Page problems:\n${problems.map((line) => `- ${line}`).join('\n')}`
          : `No page problems on tab ${tab.id} (${where}).`) + (summaryLine ? `\n${summaryLine}` : ''),
      tabs: [summary(tab)],
    };
  }

  return {
    annotate: (request: Extract<VisualizeRequest, { action: 'annotate' }>) => annotateTab(ctx, request),

    async capture(request: Extract<VisualizeRequest, { action: 'capture' }>): Promise<VisualizeResult> {
      const tab = ctx.tabs.findTab(request.sessionId, request.tab);
      if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; capture it with the browser tool`);
      const output = await resolveCaptureOutput(request.cwd, request.output);
      // During an agent turn the tab is drawn off screen, never shown.
      const held = heldTurn(ctx, request.sessionId) !== null;
      let png: Buffer;
      if (held) png = await offscreenTabPng(ctx, request.sessionId, tab);
      else {
        await ctx.tabs.display(request.sessionId, tab);
        png = await deps.capture(request.sessionId, view(tab));
      }
      await writeFile(output, png);
      return {
        text: withProblems(
          tab,
          `Captured tab ${tab.id} to ${output}${held ? ', drawn off screen (the side panel shows the tab when this turn ends)' : ''}.`
        ),
        tabs: [summary(tab)],
        path: output,
        ...problemsOf(tab),
      };
    },

    async check(request: Extract<VisualizeRequest, { action: 'check' }>): Promise<VisualizeResult> {
      const tab = ctx.tabs.findTab(request.sessionId, request.tab);
      if (tab.url || !displayedPanes(tab).some((pane) => pane.kind === 'html' || pane.inline)) {
        throw new Error(`check works on HTML tabs only; tab ${tab.id} shows no HTML page`);
      }
      if (heldTurn(ctx, request.sessionId)) return checkOffscreen(request, tab);
      await ctx.tabs.display(request.sessionId, tab);
      await ctx.problems.awaitInlineRender(tab);
      if (displayedPanes(tab).some((pane) => pane.kind === 'html'))
        await deps.ensureShown?.(request.sessionId, view(tab));
      await ctx.problems.settle(tab, PROBLEM_SETTLE_ROUNDS);
      const findings = inspectFindingsSummary(await layoutFindingCount(request.sessionId, tab));
      return {
        text:
          (tab.problems.length ? withProblems(tab, `Checked tab ${tab.id}.`) : `No page problems on tab ${tab.id}.`) +
          (findings ? `\n${findings}` : ''),
        tabs: [summary(tab)],
        ...problemsOf(tab),
      };
    },

    inspect: (request: Extract<VisualizeRequest, { action: 'inspect' }>) => inspectTab(ctx, request),

    /** The source text of displayed pane `index`: inline content as given, an
     *  HTML file as read now (a kept version from its snapshot), capped. */
    async paneText(sessionId: string, tabId: string, index: number): Promise<VisualizePaneText> {
      const tab = ctx.tabs.findTab(sessionId, tabId);
      const pane = displayedPanes(tab)[index];
      if (!pane || tab.url) throw new Error(`tab ${tab.id} has no pane ${index}`);
      if (pane.inline) return { text: pane.inline.source, truncated: false };
      if (pane.kind !== 'html') throw new Error('only HTML pages and inline content have a source view');
      const target = shownLayout(tab, tab.shown?.targets ?? [], tab.targets)[index];
      if (!target) throw new Error(`tab ${tab.id} has no pane ${index}`);
      return readPaneSource(target);
    },
  };
}
