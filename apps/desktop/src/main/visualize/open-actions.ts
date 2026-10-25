/**
 * The agent's `open` (files, inline content or a web URL) and the panel's
 * reopen of a closed visual, validated exactly like an agent open.
 */
import { randomUUID } from 'node:crypto';
import { relative } from 'node:path';

import type { VisualizeInlineContent } from '../../shared/visualize';
import { MAX_VISUALIZE_VERSIONS } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import { loadIsCurrent } from './reloads';
import {
  displayedPanes,
  type FileTarget,
  inlineKey,
  problemsOf,
  sameInline,
  summary,
  type TabState,
  type VisualizeResult,
  versionNote,
  view,
  withProblems,
} from './tab-state';
import {
  insidePath,
  parseVisualizeRequest,
  resolveVisualizeTarget,
  type VisualizeRequest,
  type VisualizeTarget,
} from './targets';
import { checkTabOffscreen } from './read-actions';
import { heldTurn } from './turn-hold';
import { shownVersionOf } from './version-thumbnails';

type OpenRequest = Extract<VisualizeRequest, { action: 'open' }>;

type OpenContext = Pick<
  VisualizeServiceContext,
  | 'deps'
  | 'sessionOf'
  | 'sessionCwds'
  | 'nextLoadStamp'
  | 'panes'
  | 'tabs'
  | 'leases'
  | 'thumbnails'
  | 'tabVersions'
  | 'views'
  | 'publish'
  | 'problems'
  | 'reloads'
  | 'holds'
  | 'panelSize'
>;

/** A reopened tab goes to the end of the session's tabs, like a fresh open. */
function moveToEnd(tabs: TabState[], tab: TabState): void {
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.push(tab);
}

/** Show the kept `version` a request asks for; a failure is only a note of
 *  the result, since the tab was already opened (and published) live. */
async function selectRequested(
  ctx: Pick<OpenContext, 'tabVersions'>,
  sessionId: string,
  tab: TabState,
  version: number
): Promise<Error | null> {
  try {
    await ctx.tabVersions.selectVersion(sessionId, tab, version, false);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** "v3", or "v3 (version 2)" from a tab's second kept version on: chat cards
 *  read the tab id and the version their open made from the result text (no
 *  version named on a host that keeps them = version 1). */
function tabRef(tab: TabState): string {
  const n = shownVersionOf(tab);
  return n > 1 ? `${tab.id} (version ${n})` : tab.id;
}

/** Where the opened tab went: "Showing" only when the user can see it now,
 *  else what stands between it and the user, so the agent can say so. Keeps
 *  the literal "as tab vN" (chat cards read the tab id from it). */
async function placement(
  deps: Pick<OpenContext['deps'], 'onScreen'>,
  sessionId: string,
  tab: TabState,
  what: string
): Promise<string> {
  const state = (await deps.onScreen?.(sessionId, view(tab))) ?? 'visible';
  if (state === 'visible') return `Showing ${what} in the side panel as tab ${tabRef(tab)}.`;
  if (state === 'background') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but the Mixdog window is in the background (another app has the focus); tell the user it is waiting in the Mixdog window.`;
  }
  if (state === 'covered') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but something in the Mixdog window covers the panel (a dialog, Settings or another overlay); the user must close it to see the tab.`;
  }
  if (state === 'other-tab') {
    return `Opened ${what} in the side panel as tab ${tabRef(tab)}, but the panel keeps showing another tab the user picked; the new tab is only marked updated in the panel's tab strip, so tell the user it is there.`;
  }
  return `Opened ${what} as tab ${tabRef(tab)}, but it is not on screen (the window is minimized or hidden, or the session is not shown); the user must bring the Mixdog window and this session's visualize panel up to see it.`;
}

/** An open during an agent turn (turn-hold.ts): kept, shown when the turn
 *  ends, and whether the user can reach the session to see it then. Keeps
 *  the literal "as tab vN" (chat cards read the tab id from it). */
async function heldPlacement(
  deps: Pick<OpenContext['deps'], 'sessionReach'>,
  sessionId: string,
  tab: TabState,
  what: string
): Promise<string> {
  const reach = (await deps.sessionReach?.(sessionId)) ?? 'shown';
  const prepared = `Prepared ${what} as tab ${tabRef(tab)}`;
  const offscreen = 'check, inspect and capture work on the tab now, off screen.';
  if (reach === 'not-open') {
    return `${prepared}, but this session is not open in the Mixdog window, so the user will not see it when this turn ends; tell the user to open this conversation to see it. ${offscreen}`;
  }
  const ends = `${prepared}; the side panel shows it when this turn ends`;
  if (reach === 'background') {
    return `${ends}, but the Mixdog window is in the background (another app has the focus); tell the user it is waiting in the Mixdog window. ${offscreen}`;
  }
  if (reach === 'hidden') {
    return `${ends}, but the Mixdog window is minimized or hidden; tell the user to bring the Mixdog window up to see it. ${offscreen}`;
  }
  return `${ends} (it is left alone until then, so open again freely after edits). ${offscreen}`;
}

/** A held open's load check (nothing renders the tab until the turn ends):
 *  the problems its pages or inline content show off screen, as a section of
 *  the result; '' when there are none or nothing here can check them. */
async function heldLoadCheck(
  ctx: Pick<OpenContext, 'deps' | 'panelSize'>,
  sessionId: string,
  cwd: string,
  tab: TabState
): Promise<string> {
  const panes = displayedPanes(tab);
  const pages = panes.some((pane) => pane.kind === 'html');
  const inline = panes.some((pane) => pane.kind === 'inline');
  if (pages ? !ctx.deps.inspectOffscreen : !(inline && ctx.deps.exportBytes)) return '';
  try {
    const { problems } = await checkTabOffscreen(ctx, sessionId, cwd, tab);
    return problems.length
      ? `\nPage problems while it loaded off screen:\n${problems.map((line) => `- ${line}`).join('\n')}`
      : '';
  } catch (error) {
    return `\nThe off-screen load check failed: ${(error as Error).message}`;
  }
}

/** The result's note on a requested version that could not be shown. */
function versionErrorNote(error: Error | null, tab: TabState, live: string): string {
  return error ? ` Version not shown: ${error.message}; tab ${tab.id} shows the ${live}.` : '';
}

/** `open` with `input.content`: a direct-renderer tab, no files. Reopening
 *  the same title keeps the tab and adds a version when the content changed. */
async function openInline(
  ctx: Pick<
    OpenContext,
    | 'deps'
    | 'sessionOf'
    | 'sessionCwds'
    | 'panes'
    | 'tabs'
    | 'leases'
    | 'thumbnails'
    | 'tabVersions'
    | 'views'
    | 'publish'
    | 'problems'
    | 'holds'
    | 'panelSize'
  >,
  request: OpenRequest,
  content: VisualizeInlineContent
): Promise<VisualizeResult> {
  const { sessionOf, sessionCwds } = ctx;
  const { sessionId, cwd } = request;
  const held = heldTurn(ctx, sessionId) !== null;
  const state = sessionOf(sessionId);
  const key = inlineKey(content);
  const pane = await ctx.panes.inlinePaneFor(content);
  let tab = state.tabs.find((candidate) => candidate.key === key);
  if (tab) {
    tab.label = request.label ?? tab.label;
    tab.cwd = cwd;
    tab.inline = content;
    tab.panes = [pane];
    tab.problems = [];
    ctx.thumbnails.invalidate(tab);
    moveToEnd(state.tabs, tab);
  } else {
    state.counter += 1;
    tab = {
      id: `v${state.counter}`,
      label: request.label ?? pane.label,
      key,
      cwd,
      revision: 0,
      inline: content,
      inlineHistory: [],
      targets: [],
      panes: [pane],
      unwatch: [],
      reloadTimer: null,
      problems: [],
      problemSeq: 0,
      allowNetwork: true,
    };
    ctx.tabs.addTab(sessionId, tab);
  }
  tab.rendered = new Set();
  tab.shown = null;
  tab.compare = false;
  ctx.leases.claimLeases(tab, tab.panes);
  const history = tab.inlineHistory ?? [];
  if (!history.length || !sameInline(history[history.length - 1].content, content)) {
    history.push({ n: (history.at(-1)?.n ?? 0) + 1, at: Date.now(), content });
    if (history.length > MAX_VISUALIZE_VERSIONS) history.shift();
  }
  tab.inlineHistory = history;
  tab.versions = history.map(({ n, at, turns }) => ({ n, at, ...(turns?.length ? { turns } : {}) }));
  const versionError =
    request.version === undefined ? null : await selectRequested(ctx, sessionId, tab, request.version);
  // A held open activates nothing: the turn's end shows its last tab.
  if (!held) state.active = tab.id;
  ctx.views.rememberTab(sessionId, tab, true);
  ctx.publish(sessionId, tab.id);
  const what = `inline ${content.kind}${content.title ? ` "${content.title}"` : ''}`;
  const placed = held
    ? await heldPlacement(ctx.deps, sessionId, tab, what)
    : await placement(ctx.deps, sessionId, tab, what);
  // Nothing renders a held tab: it is checked off screen instead.
  let loaded = '';
  if (held) loaded = await heldLoadCheck(ctx, sessionId, cwd, tab);
  else {
    await ctx.problems.awaitInlineRender(tab);
    // A scripted page gets a moment to load, so its first errors ride this result.
    if (displayedPanes(tab).some((candidate) => candidate.kind === 'html')) await ctx.problems.settle(tab, 1);
  }
  sessionCwds.set(sessionId, cwd);
  ctx.thumbnails.refresh(sessionId, tab);
  return {
    text: withProblems(
      tab,
      `${placed} Open again with the same title to add a version.${versionNote(tab)}${versionErrorNote(versionError, tab, 'live content')}${loaded}`
    ),
    tabs: [summary(tab)],
    ...problemsOf(tab),
  };
}

/** `open` of a web URL: handed to the session's browser panel; the tab
 *  only records it. */
async function openUrl(
  ctx: Pick<OpenContext, 'deps' | 'sessionOf' | 'tabs'>,
  request: OpenRequest,
  target: Extract<VisualizeTarget, { kind: 'url' }>
): Promise<VisualizeResult> {
  const { deps, sessionOf } = ctx;
  const { sessionId, cwd } = request;
  if (!deps.browserAvailable()) {
    throw new Error('web URLs open in the browser panel, which needs the Browser Use feature installed');
  }
  // The pane opens this URL in a new tab and names it with this id: the page
  // that tab creates (not an older page at the same address, nor a tab the
  // user opened) is the one the browser tool must drive.
  const openRequestId = randomUUID();
  const watch = deps.watchBrowserTab?.(sessionId, openRequestId);
  try {
    deps.publish({ sessionId, openUrl: target.url, openRequestId });
    deps.publishHost?.({ sessionId, openUrl: target.url });
  } catch (error) {
    watch?.cancel();
    throw error;
  }
  const state = sessionOf(sessionId);
  let tab = state.tabs.find((candidate) => candidate.url === target.url);
  if (!tab) {
    state.counter += 1;
    tab = {
      id: `v${state.counter}`,
      label: request.label ?? target.label,
      key: `url:${target.url}`,
      cwd,
      revision: 0,
      url: target.url,
      targets: [],
      panes: [],
      unwatch: [],
      reloadTimer: null,
      problems: [],
      problemSeq: 0,
    };
    ctx.tabs.addTab(sessionId, tab);
  }
  // The tab id only names this record: the browser tool's `v1` is the panel's
  // first open page, often an older one. The page's own id (`p…`) is what
  // the browser tool takes. Without a browser host nothing is awaited.
  const pageId = (await watch?.page) ?? null;
  const text = pageId
    ? `Opened ${target.url} in the session's browser panel as page ${pageId}; pass tab:"${pageId}" to the browser tool.`
    : `Opened ${target.url} in the session's browser panel; its page id (p…) is not known yet, so find it with the browser tool's list_tabs.`;
  return { text, tabs: [summary(tab)] };
}

export function createOpenActions(ctx: OpenContext) {
  const { deps, sessionOf, sessionCwds } = ctx;

  async function open(request: OpenRequest): Promise<VisualizeResult> {
    if (!deps.windowAvailable()) throw new Error('the Mixdog desktop window is not open');
    if (request.content) return openInline(ctx, request, request.content);
    const { sessionId, cwd } = request;
    const stamp = ctx.nextLoadStamp();
    const targets = await Promise.all(request.targets.map((target) => resolveVisualizeTarget(cwd, target)));
    const web = targets.filter((target) => target.kind === 'url');
    if (web.length) {
      if (targets.length > 1) {
        throw new Error('a web URL opens alone in the browser panel; pass it as the only target');
      }
      if (request.version !== undefined)
        throw new Error('input.version applies to file tabs; a web URL keeps no versions');
      return openUrl(ctx, request, web[0]);
    }
    const files = targets as FileTarget[];
    const key = files.map((target) => target.path).join('\0');
    const panes = await ctx.panes.preparePanes(files);
    const state = sessionOf(sessionId);
    let tab = state.tabs.find((candidate) => candidate.key === key);
    const label = request.label ?? files.map((target) => target.label).join(' · ');
    // A reload or reopen started after this open already committed newer
    // files and cwd: this open's resolution is stale and is dropped.
    const stale = tab !== undefined && !loadIsCurrent(tab, stamp);
    if (tab && stale) {
      tab.label = request.label ?? tab.label;
      moveToEnd(state.tabs, tab);
    } else if (tab) {
      ctx.tabs.dispose(tab);
      tab.label = request.label ?? tab.label;
      // cwd and the targets' roots always come from the same open, committed together.
      tab.cwd = cwd;
      tab.loadedStamp = stamp;
      tab.targets = files;
      tab.panes = panes;
      tab.problems = [];
      ctx.thumbnails.invalidate(tab);
      // Reopening moves the tab to the end, like a fresh open.
      moveToEnd(state.tabs, tab);
    } else {
      state.counter += 1;
      tab = {
        id: `v${state.counter}`,
        label,
        key,
        cwd,
        loadedStamp: stamp,
        revision: 0,
        targets: files,
        panes,
        unwatch: [],
        reloadTimer: null,
        problems: [],
        problemSeq: 0,
        allowNetwork: true,
      };
      ctx.tabs.addTab(sessionId, tab);
    }
    if (!stale) {
      ctx.leases.claimLeases(tab, panes);
      ctx.reloads.watchTab(sessionId, tab);
    }
    // An agent open shows the live files; a kept version only on request.
    if (tab.shown) ctx.thumbnails.invalidate(tab);
    tab.shown = null;
    tab.compare = false;
    tab.pendingReload = false;
    await ctx.tabVersions.recordVersion(sessionId, tab);
    const versionError =
      request.version === undefined ? null : await selectRequested(ctx, sessionId, tab, request.version);
    const held = heldTurn(ctx, sessionId) !== null;
    // A held open activates nothing: the turn's end shows its last tab.
    if (!held) state.active = tab.id;
    ctx.views.rememberTab(sessionId, tab, true);
    ctx.publish(sessionId, tab.id);
    const shown = files
      .map((target) => {
        // A file outside the working directory is named by its full path.
        const shown = insidePath(cwd, target.path) ? relative(cwd, target.path).replace(/\\/g, '/') : target.path;
        return `${shown || target.label} (${target.kind})`;
      })
      .join(', ');
    const placed = held
      ? await heldPlacement(deps, sessionId, tab, shown)
      : await placement(deps, sessionId, tab, shown);
    // Give a fresh page a moment to load, so its first errors ride this result
    // (a held tab loads nowhere yet: it is checked off screen instead).
    let loaded = '';
    if (held) loaded = await heldLoadCheck(ctx, sessionId, cwd, tab);
    else if (panes.some((pane) => pane.kind === 'html')) await ctx.problems.settle(tab, 1);
    // A dropped open's cwd is as stale as its files: the session keeps the
    // cwd of the load that committed. A later open that overtook this one
    // during settle owns the tab's cwd now, and records its own.
    if (!stale && tab.cwd === cwd) sessionCwds.set(sessionId, cwd);
    ctx.thumbnails.refresh(sessionId, tab);
    return {
      text: withProblems(
        tab,
        `${placed} The tab reloads when ${files.length > 1 ? 'these files change' : 'the file changes'}.${versionNote(tab)}${versionErrorNote(versionError, tab, 'live files')}${loaded}`
      ),
      tabs: [summary(tab)],
      ...problemsOf(tab),
    };
  }

  return {
    open,
    /** Open `targets` (or inline `content`) again in the session's last working
     *  directory: the working directory is main's to know, never the client's,
     *  and the targets are validated exactly like an agent open. */
    async reopen(
      sessionId: string,
      targets: string[],
      content: VisualizeInlineContent | undefined,
      label: string | undefined
    ): Promise<void> {
      const cwd = sessionCwds.get(sessionId) ?? (await deps.sessionCwd?.(sessionId)) ?? null;
      if (!cwd) throw new Error("the session's working directory is unknown; ask the agent to show it again");
      await open(
        parseVisualizeRequest({
          sessionId,
          cwd,
          action: 'open',
          input: { ...(content ? { content } : { targets }), ...(label ? { label } : {}) },
        }) as OpenRequest
      );
    },
  };
}

export type OpenActions = ReturnType<typeof createOpenActions>;
