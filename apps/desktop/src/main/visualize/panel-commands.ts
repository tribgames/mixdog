import type { DesktopVisualizeTabCommand, VisualizeCommandResult } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import type { SessionState, TabState } from './tab-state';
import {
  dropShown,
  followShown,
  pickShown,
  publishShown,
  refusePast,
  shownAs,
  shownOfKey,
  type TurnHold,
} from './turn-hold';
import { versionThumbnail } from './version-thumbnails';

export function createPanelCommands(
  ctx: Pick<
    VisualizeServiceContext,
    | 'deps'
    | 'views'
    | 'sessions'
    | 'versions'
    | 'tabs'
    | 'opens'
    | 'exports'
    | 'tabVersions'
    | 'problems'
    | 'reloads'
    | 'thumbnails'
    | 'publish'
    | 'holds'
  >
) {
  const { sessions } = ctx;
  /** The user selected `tab` with no turn running. */
  const select = (sessionId: string, state: SessionState, tab: TabState): void => {
    // Activating the tab already shown changes nothing: no publish, no job.
    if (state.active === tab.id) return;
    state.active = tab.id;
    ctx.publish(sessionId);
    ctx.thumbnails.whenMissing(sessionId, tab);
  };
  /** The user selected `tabId` of what the session shows during a turn: no request to see the turn's work. */
  const pick = (sessionId: string, hold: TurnHold, tabId: string): void => {
    const state = sessions.get(sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === tabId);
    const live = shownAs(ctx, hold, sessionId, tabId) === 'live';
    if (live && state) state.active = tabId;
    pickShown(ctx.deps, hold, sessionId, tabId);
    if (live && tab) ctx.thumbnails.whenMissing(sessionId, tab);
  };
  /** A command during a turn, by how the session shows its tab (turn-hold.ts `shownAs`). */
  const held = async (
    command: DesktopVisualizeTabCommand,
    hold: TurnHold
  ): Promise<VisualizeCommandResult | undefined> => {
    const { sessionId } = command;
    if (command.action === 'history') {
      const entry = sessions.get(sessionId)?.history.find((candidate) => candidate.id === command.entry);
      if (!entry) throw new Error("that visual is no longer in this session's list");
      // A visual the session shows is selected; one it does not, or shows as the running turn's own, is the user's
      // own open (as a reopen is), which decides how it is seen.
      const shown = shownOfKey(hold, entry.key);
      if (shown && !hold.shown.turn.has(shown)) pick(sessionId, hold, shown);
      else await ctx.opens.reopen(sessionId, entry.targets, entry.content, entry.label);
      return;
    }
    const as = shownAs(ctx, hold, sessionId, command.tabId);
    if (!as) return;
    if (command.action === 'activate') {
      pick(sessionId, hold, command.tabId);
      return;
    }
    if (as === 'past') {
      // A picture from before the running turn's change: it can go, nothing else can be done to it.
      if (command.action !== 'close') refusePast(ctx, sessionId, command.tabId);
      dropShown(hold, command.tabId);
      publishShown(ctx.deps, hold, sessionId);
      return;
    }
    try {
      return await run(command);
    } finally {
      const current = ctx.holds.get(sessionId);
      if (current && command.action !== 'export') {
        followShown(ctx, current, sessionId, command.tabId);
        publishShown(ctx.deps, current, sessionId);
      }
    }
  };
  const run = async (command: DesktopVisualizeTabCommand): Promise<VisualizeCommandResult | undefined> => {
    if (command.action === 'close') {
      ctx.tabs.closeTab(command.sessionId, command.tabId);
      return;
    }
    if (command.action === 'reopen') {
      await ctx.opens.reopen(command.sessionId, command.targets, command.content, command.label);
      return;
    }
    if (command.action === 'history') {
      const state = sessions.get(command.sessionId);
      const entry = state?.history.find((candidate) => candidate.id === command.entry);
      if (!state || !entry) throw new Error("that visual is no longer in this session's list");
      const live = state.tabs.find((candidate) => candidate.key === entry.key && !candidate.url);
      if (live) {
        select(command.sessionId, state, live);
        return;
      }
      await ctx.opens.reopen(command.sessionId, entry.targets, entry.content, entry.label);
      return;
    }
    const state = sessions.get(command.sessionId);
    const tab = state?.tabs.find((candidate) => candidate.id === command.tabId && !candidate.url);
    if (!state || !tab) return;
    if (command.action === 'restore') {
      await ctx.tabVersions.restoreVersion(command.sessionId, tab, command.version, command.assets ?? []);
      return;
    }
    if (command.action === 'render') {
      ctx.problems.reportInlineRender(command.sessionId, tab, command.pane, command.renderId, command.error);
      return;
    }
    if (command.action === 'blocked') {
      ctx.problems.reportRemoteBlockedNetwork(command.sessionId, tab, command.pane, command.url, command.resource);
      return;
    }
    if (command.action === 'export')
      return ctx.exports.exportTab(command.sessionId, tab, command.format, command.pane ?? 0);
    if (command.action === 'network') {
      if (!!tab.allowNetwork === command.allow) return;
      tab.allowNetwork = command.allow;
      // Inline pages are held in memory, not reloaded from files: remount them.
      if (tab.shown || tab.inline) {
        // A kept version is on screen: remount its pages under the new policy.
        ctx.thumbnails.invalidate(tab);
        tab.problems = [];
        tab.problemSeq += 1;
        ctx.publish(command.sessionId);
      } else {
        await ctx.reloads.reload(command.sessionId, tab);
      }
      return;
    }
    if (command.action === 'version') {
      await ctx.tabVersions.selectVersion(command.sessionId, tab, command.version, command.compare === true);
      await ctx.tabVersions.afterSelect(command.sessionId, tab);
      return;
    }
    select(command.sessionId, state, tab);
  };
  return {
    async command(command: DesktopVisualizeTabCommand): Promise<VisualizeCommandResult | undefined> {
      // A card's picture is a read: it changes nothing and never lifts a hold.
      if (command.action === 'thumbnail') {
        const tab = sessions.get(command.sessionId)?.tabs.find((candidate) => candidate.id === command.tabId);
        const thumbnail = tab && !tab.url ? versionThumbnail(ctx, command.sessionId, tab, command.version) : '';
        return thumbnail ? { thumbnail } : {};
      }
      // No command lifts a running turn's hold. A pane's own reports name the tab the page was drawn from, and a
      // reopen is decided where its file is resolved (open-actions.ts).
      const hold = ctx.holds.get(command.sessionId);
      const reports = command.action === 'render' || command.action === 'blocked' || command.action === 'reopen';
      return hold && !reports ? held(command, hold) : run(command);
    },
  };
}
