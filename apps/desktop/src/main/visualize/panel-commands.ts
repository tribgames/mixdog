import type { DesktopVisualizeTabCommand, VisualizeCommandResult } from '../../shared/visualize';
import type { VisualizeServiceContext } from './context';
import { versionThumbnail } from './version-thumbnails';

export function createPanelCommands(
  ctx: Pick<
    VisualizeServiceContext,
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
        if (state.active === live.id) return;
        state.active = live.id;
        ctx.publish(command.sessionId);
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
    // Activating the tab already shown changes nothing: no publish, no job.
    if (state.active === command.tabId) return;
    state.active = command.tabId;
    ctx.publish(command.sessionId);
    ctx.thumbnails.whenMissing(command.sessionId, tab);
  };
  return {
    async command(command: DesktopVisualizeTabCommand): Promise<VisualizeCommandResult | undefined> {
      // A card's picture is a read: it changes nothing and never lifts a hold.
      if (command.action === 'thumbnail') {
        const tab = sessions.get(command.sessionId)?.tabs.find((candidate) => candidate.id === command.tabId);
        const thumbnail = tab && !tab.url ? versionThumbnail(ctx, command.sessionId, tab, command.version) : '';
        return thumbnail ? { thumbnail } : {};
      }
      const hold =
        command.action === 'render' || command.action === 'blocked' ? undefined : ctx.holds.get(command.sessionId);
      if (hold) hold.bypass += 1;
      try {
        return await run(command);
      } finally {
        if (hold) hold.bypass -= 1;
      }
    },
  };
}
