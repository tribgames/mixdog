/**
 * The agent's `open` (files, inline content or a web URL) and the panel's
 * reopen of a closed visual, validated exactly like an agent open.
 */
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
  realCwdOf,
  sameInline,
  summary,
  type TabState,
  type VisualizeResult,
  versionNote,
  view,
  withProblems,
} from './tab-state';
import { parseVisualizeRequest, resolveVisualizeTarget, type VisualizeRequest, type VisualizeTarget } from './targets';

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
>;

/** Show the kept `version` a request asks for; the error is reported only
 *  after the tab was published live. */
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
  if (state === 'visible') return `Showing ${what} in the side panel as tab ${tab.id}.`;
  if (state === 'background') {
    return `Opened ${what} in the side panel as tab ${tab.id}, but the Mixdog window is in the background (another app has the focus); tell the user it is waiting in the Mixdog window.`;
  }
  if (state === 'covered') {
    return `Opened ${what} in the side panel as tab ${tab.id}, but something in the Mixdog window covers the panel (a dialog, Settings or another overlay); the user must close it to see the tab.`;
  }
  return `Opened ${what} as tab ${tab.id}, but it is not on screen (the window is minimized or hidden, or the session is not shown); the user must bring the Mixdog window and this session's visualize panel up to see it.`;
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
  >,
  request: OpenRequest,
  content: VisualizeInlineContent
): Promise<VisualizeResult> {
  const { sessionOf, sessionCwds } = ctx;
  const { sessionId, cwd } = request;
  const state = sessionOf(sessionId);
  const key = inlineKey(content);
  const [pane, realCwd] = await Promise.all([ctx.panes.inlinePaneFor(content), realCwdOf(cwd)]);
  let tab = state.tabs.find((candidate) => candidate.key === key);
  if (tab) {
    tab.label = request.label ?? tab.label;
    tab.cwd = cwd;
    tab.realCwd = realCwd;
    tab.inline = content;
    tab.panes = [pane];
    tab.problems = [];
    ctx.thumbnails.invalidate(tab);
    state.tabs.splice(state.tabs.indexOf(tab), 1);
    state.tabs.push(tab);
  } else {
    state.counter += 1;
    tab = {
      id: `v${state.counter}`,
      label: request.label ?? pane.label,
      key,
      cwd,
      realCwd,
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
  tab.versions = history.map(({ n, at }) => ({ n, at }));
  const versionError =
    request.version === undefined ? null : await selectRequested(ctx, sessionId, tab, request.version);
  state.active = tab.id;
  ctx.views.rememberTab(sessionId, tab, true);
  ctx.publish(sessionId, tab.id);
  if (versionError) throw new Error(`${versionError.message}; tab ${tab.id} shows the live content`);
  const placed = await placement(
    ctx.deps,
    sessionId,
    tab,
    `inline ${content.kind}${content.title ? ` "${content.title}"` : ''}`
  );
  await ctx.problems.awaitInlineRender(tab);
  // A scripted page gets a moment to load, so its first errors ride this result.
  if (displayedPanes(tab).some((candidate) => candidate.kind === 'html')) await ctx.problems.settle(tab, 1);
  sessionCwds.set(sessionId, cwd);
  ctx.thumbnails.refresh(sessionId, tab);
  return {
    text: withProblems(tab, `${placed} Open again with the same title to add a version.${versionNote(tab)}`),
    tabs: [summary(tab)],
    ...problemsOf(tab),
  };
}

/** `open` of a web URL: handed to the session's browser panel; the tab
 *  only records it. */
function openUrl(
  ctx: Pick<OpenContext, 'deps' | 'sessionOf' | 'tabs'>,
  request: OpenRequest,
  target: Extract<VisualizeTarget, { kind: 'url' }>
): VisualizeResult {
  const { deps, sessionOf } = ctx;
  const { sessionId, cwd } = request;
  if (!deps.browserAvailable()) {
    throw new Error('web URLs open in the browser panel, which needs the Browser Use feature installed');
  }
  deps.publish({ sessionId, openUrl: target.url });
  deps.publishHost?.({ sessionId, openUrl: target.url });
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
  return { text: `Opened ${target.url} in the session's browser panel (tab ${tab.id}).`, tabs: [summary(tab)] };
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
    const realCwd = await realCwdOf(cwd);
    const panes = await ctx.panes.preparePanes(files, cwd, realCwd);
    const state = sessionOf(sessionId);
    let tab = state.tabs.find((candidate) => candidate.key === key);
    const label = request.label ?? files.map((target) => target.label).join(' · ');
    // A reload or reopen started after this open already committed newer
    // files and cwd: this open's resolution is stale and is dropped.
    const stale = tab !== undefined && !loadIsCurrent(tab, stamp);
    if (tab && stale) {
      tab.label = request.label ?? tab.label;
      state.tabs.splice(state.tabs.indexOf(tab), 1);
      state.tabs.push(tab);
    } else if (tab) {
      ctx.tabs.dispose(tab);
      tab.label = request.label ?? tab.label;
      // cwd and realCwd always come from the same open, committed together.
      tab.cwd = cwd;
      tab.realCwd = realCwd;
      tab.loadedStamp = stamp;
      tab.targets = files;
      tab.panes = panes;
      tab.problems = [];
      ctx.thumbnails.invalidate(tab);
      // Reopening moves the tab to the end, like a fresh open.
      state.tabs.splice(state.tabs.indexOf(tab), 1);
      state.tabs.push(tab);
    } else {
      state.counter += 1;
      tab = {
        id: `v${state.counter}`,
        label,
        key,
        cwd,
        realCwd,
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
    state.active = tab.id;
    ctx.views.rememberTab(sessionId, tab, true);
    ctx.publish(sessionId, tab.id);
    if (versionError) throw new Error(`${versionError.message}; tab ${tab.id} shows the live files`);
    const shown = files
      .map((target) => `${relative(cwd, target.path).replace(/\\/g, '/') || target.label} (${target.kind})`)
      .join(', ');
    const placed = await placement(deps, sessionId, tab, shown);
    // Give a fresh page a moment to load, so its first errors ride this result.
    if (panes.some((pane) => pane.kind === 'html')) await ctx.problems.settle(tab, 1);
    // A dropped open's cwd is as stale as its files: the session keeps the
    // cwd of the load that committed. A later open that overtook this one
    // during settle owns the tab's cwd now, and records its own.
    if (!stale && tab.cwd === cwd) sessionCwds.set(sessionId, cwd);
    ctx.thumbnails.refresh(sessionId, tab);
    return {
      text: withProblems(
        tab,
        `${placed} The tab reloads when ${files.length > 1 ? 'these files change' : 'the file changes'}.${versionNote(tab)}`
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
