/**
 * Exports of a tab: the agent's `export` (a file inside the project, under
 * one host deadline) and the panel's Export menu (project save or the OS
 * save dialog).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VisualizeCommandResult, VisualizePaneView } from '../../shared/visualize';
import { EXPORT_DEADLINE_MS, exportedText, runWithExportDeadline } from './agent-export';
import type { VisualizeServiceContext } from './context';
import type { VisualizeServiceDeps } from './service';
import { MOCKUPS_DIRECTORY, mockupSlug, resolveExportOutput, saveInlineToProject, writeExportFile } from './export';
import {
  displayedPanes,
  exportSummary,
  problemsOf,
  shownLayout,
  type TabState,
  type VisualizeResult,
  view,
  withProblems,
} from './tab-state';
import { noVersion } from './tab-versions';
import type { VisualizeRequest } from './targets';

type ExportRequest = Extract<VisualizeRequest, { action: 'export' }>;

export function createExportActions(ctx: Pick<VisualizeServiceContext, 'deps' | 'versions' | 'tabs' | 'panes'>) {
  const { deps, versions } = ctx;

  /** The page an agent export renders: live `tab.panes`, or kept `version`'s
   *  snapshot (prepared for this render only; the tab's own view is untouched). */
  async function exportPanes(
    sessionId: string,
    tab: TabState,
    version: number | undefined
  ): Promise<VisualizePaneView[]> {
    if (version === undefined) return tab.panes;
    if (tab.inline) {
      const history = tab.inlineHistory ?? [];
      const found = history.find((candidate) => candidate.n === version);
      if (!found)
        throw noVersion(
          tab,
          version,
          history.map((candidate) => candidate.n)
        );
      return [await ctx.panes.inlinePaneFor(found.content)];
    }
    const list = versions?.list(sessionId, tab.id) ?? [];
    const found = list.find((candidate) => candidate.n === version);
    if (!found)
      throw noVersion(
        tab,
        version,
        list.map((candidate) => candidate.n)
      );
    const targets = found.panes.map((rel, pane) => ({
      ...tab.targets[pane],
      path: join(found.dir, ...rel.split('/')),
    }));
    return ctx.panes.preparePanes(targets, found.dir);
  }

  async function exportWork(request: ExportRequest, signal: AbortSignal, commit: () => void): Promise<VisualizeResult> {
    const { format, version } = request;
    const tab = ctx.tabs.findTab(request.sessionId, request.tab);
    if (tab.url) throw new Error(`tab ${tab.id} lives in the browser panel; capture it with the browser tool`);
    const rel = await resolveExportOutput(request.cwd, request.output, format);
    const panes = await exportPanes(request.sessionId, tab, version);
    const page = panes.length === 1 && panes[0].kind === 'html' ? panes[0] : null;
    if (format === 'pdf' && !page)
      throw new Error(`Save as PDF is for a single HTML page; tab ${tab.id} shows no such page (export png instead)`);
    if (version !== undefined && !page)
      throw new Error(`exporting a kept version needs a single HTML page; tab ${tab.id} version ${version} is not one`);
    let data: Buffer;
    let problemLines: string[] = [];
    let how: string;
    if (page) {
      if (!deps.renderExport) throw new Error('exporting to a file is unavailable');
      ({ data, problems: problemLines } = await deps.renderExport(page, format, tab.allowNetwork === true, {
        roots: [request.cwd, tab.cwd],
        signal,
      }));
      how = 'rendered off screen: the tab did not need to be on screen';
    } else {
      await ctx.tabs.display(request.sessionId, tab);
      data = await deps.capture(request.sessionId, view(tab));
      how = 'captured as the panel shows it';
    }
    commit();
    await writeExportFile(request.cwd, rel, data, { overwrite: request.overwrite });
    const text = exportedText(tab.id, version, rel, format, data, how);
    const problems = problemLines.length
      ? `\nPage problems during the render:\n${problemLines.map((line) => `- ${line}`).join('\n')}`
      : '';
    return {
      text: page ? `${text}${problems}` : withProblems(tab, text),
      tabs: [exportSummary(tab, request.cwd)],
      path: rel,
      ...(page ? {} : problemsOf(tab)),
    };
  }

  return {
    /** The agent's `export`: tab (or one kept version of it) → PNG / PDF file
     *  inside the project. A single HTML page (file, inline html/chart) is
     *  rendered whole in a hidden window, so the tab need not be on screen;
     *  anything else falls back to `capture`'s view of the displayed tab.
     *  The whole request has one host deadline: when it passes, the hidden
     *  window is destroyed and nothing is written. Errors and results carry
     *  project-relative paths only. */
    exportToFile(request: ExportRequest): Promise<VisualizeResult> {
      return runWithExportDeadline(deps.exportDeadlineMs ?? EXPORT_DEADLINE_MS, request.cwd, (signal, commit) =>
        exportWork(request, signal, commit)
      );
    },

    /** The panel's Export menu: `project` saves inline content under
     *  design/mockups/ in the working directory; `png` / `pdf` go through the
     *  OS save dialog (desktop window only; the remote path refuses them). */
    async exportTab(
      sessionId: string,
      tab: TabState,
      format: 'png' | 'pdf' | 'project',
      paneIndex: number,
      /** Where a PNG/PDF goes instead of the save dialog (a paired device's
       *  download: a fresh temp file). */
      choosePath: VisualizeServiceDeps['chooseExportPath'] = deps.chooseExportPath,
      /** Set: draw without the desktop panel wherever a pane can be drawn so;
       *  `onPagesCut` hears of a document stacked from only its first pages. */
      offscreen?: { onPagesCut(included: number, total: number): void }
    ): Promise<VisualizeCommandResult> {
      const pane = displayedPanes(tab)[paneIndex];
      if (!pane) throw new Error(`tab ${tab.id} has no pane ${paneIndex}`);
      if (format === 'project') {
        if (!pane.inline)
          throw new Error('only inline content can be saved to the project; a file tab already is a project file');
        const saved = await saveInlineToProject(tab.cwd, pane.inline, tab.label);
        return { path: saved.rel, openable: saved.openable };
      }
      if (!choosePath || !deps.exportBytes) throw new Error('exporting to a file is unavailable');
      if (format === 'pdf' && pane.kind !== 'html' && pane.kind !== 'pdf')
        throw new Error('Save as PDF is for HTML pages');
      const name = `${mockupSlug(pane.inline?.title ?? tab.label, pane.inline?.kind ?? 'visual')}.${format}`;
      const target = await choosePath({
        sessionId,
        directory: join(tab.cwd, ...MOCKUPS_DIRECTORY.split('/')),
        fallback: tab.cwd,
        name,
        format,
      });
      if (!target) return { canceled: true };
      const files = offscreen
        ? shownLayout(tab, tab.shown?.targets ?? [], tab.targets).map((file) => file.path)
        : undefined;
      await writeFile(
        target,
        await deps.exportBytes(sessionId, view(tab), format, paneIndex, files, offscreen?.onPagesCut)
      );
      return { path: target };
    },
  };
}

export type ExportActions = ReturnType<typeof createExportActions>;
