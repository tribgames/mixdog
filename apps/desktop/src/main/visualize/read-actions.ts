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
  problemsOf,
  shownLayout,
  summary,
  type TabState,
  type VisualizeResult,
  view,
  withProblems,
} from './tab-state';
import { resolveCaptureOutput, type VisualizeRequest } from './targets';

export function createReadActions(ctx: Pick<VisualizeServiceContext, 'deps' | 'tabs' | 'problems' | 'publish'>) {
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

  return {
    async annotate(request: Extract<VisualizeRequest, { action: 'annotate' }>): Promise<VisualizeResult> {
      const tab = ctx.tabs.findTab(request.sessionId, request.tab);
      if (tab.url || !tab.panes.some((pane) => pane.kind === 'html')) {
        throw new Error(`annotate works on HTML tabs only; tab ${tab.id} shows no HTML page`);
      }
      await ctx.tabs.display(request.sessionId, tab);
      // The marks live in the tab state: the desktop window draws them from
      // there (below), every paired device from the published state.
      const htmlPanes = displayedPanes(tab).flatMap((pane, index) => (pane.kind === 'html' ? [index] : []));
      let marks = applyVisualizeAnnotationOp(currentAnnotations(tab), request.op, htmlPanes);
      const results = await deps.annotate(request.sessionId, view(tab), marks);
      // A selector the page's own parser refused is no mark anywhere.
      const invalid = new Set((results ?? []).flatMap(({ result }) => result.invalid));
      if (invalid.size) marks = marks.filter((mark) => !invalid.has(mark.selector));
      tab.annotations = { revision: tab.revision, marks };
      ctx.publish(request.sessionId);
      // Only a paired device shows the tab: it draws the marks; no counts here.
      const named = [
        ...new Set(marks.map((mark) => (mark.label ? `${mark.selector} "${mark.label}"` : mark.selector))),
      ];
      const lines = results
        ? annotationLines(results)
        : [
            `${named.join('; ') || 'no marks'} (drawn on the paired device showing the tab; not checked against the page here)`,
          ];
      return {
        text: withProblems(tab, [`Annotations on tab ${tab.id} (cleared when the page reloads):`, ...lines].join('\n')),
        tabs: [summary(tab)],
        ...problemsOf(tab),
      };
    },

    async capture(request: Extract<VisualizeRequest, { action: 'capture' }>): Promise<VisualizeResult> {
      const tab = ctx.tabs.findTab(request.sessionId, request.tab);
      if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; capture it with the browser tool`);
      const output = await resolveCaptureOutput(request.cwd, request.output);
      await ctx.tabs.display(request.sessionId, tab);
      const png = await deps.capture(request.sessionId, view(tab));
      await writeFile(output, png);
      return {
        text: withProblems(tab, `Captured tab ${tab.id} to ${output}.`),
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

    async inspect(request: Extract<VisualizeRequest, { action: 'inspect' }>): Promise<VisualizeResult> {
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
      if (!deps.inspect) throw new Error('inspect is unavailable here');
      await ctx.tabs.display(request.sessionId, tab);
      await ctx.problems.awaitInlineRender(tab);
      // The reader checks the tab is on screen itself (and says when only a
      // remote device shows it); page problems are captured while it is.
      const answers = await deps.inspect(request.sessionId, view(tab), {
        ...(request.viewport ? { viewport: request.viewport } : {}),
        ...(request.selector ? { selector: request.selector } : {}),
      });
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
    },

    /** The source text of displayed pane `index`: inline content as given, an
     *  HTML file as read now (a kept version from its snapshot), capped. */
    async paneText(sessionId: string, tabId: string, index: number): Promise<VisualizePaneText> {
      const tab = ctx.tabs.findTab(sessionId, tabId);
      const pane = displayedPanes(tab)[index];
      if (!pane || tab.url) throw new Error(`tab ${tab.id} has no pane ${index}`);
      if (pane.inline) return { text: pane.inline.source, truncated: false };
      if (pane.kind !== 'html') throw new Error('only HTML pages and inline content have a source view');
      const shown = tab.shown;
      const live = tab.targets.map((target) => ({ target, root: tab.cwd }));
      const old = shown?.targets.map((target) => ({ target, root: shown.dir })) ?? [];
      const entry = shownLayout(tab, old, live)[index];
      if (!entry) throw new Error(`tab ${tab.id} has no pane ${index}`);
      return readPaneSource(entry.target, entry.root);
    },
  };
}
