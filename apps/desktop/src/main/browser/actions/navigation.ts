/**
 * Moving between documents: open, navigate (or reload), back and forward.
 */
import { type BrowserCommandResult, NAVIGATE_SETTLE_TIMEOUT_MS } from '../command';
import { pushBounded } from '../guest-state';
import { redactBrowserText } from '../redaction';
import { pause } from '../settle';
import { type BrowserActionContext, defineBrowserActions } from './types';

export const navigationActions = defineBrowserActions({
  async open({ targetIsBackground }) {
    return { text: targetIsBackground ? 'Background browser page is ready.' : 'Browser Use page is ready.' };
  },

  async navigate({ guest, command, signal, ownerSessionId, actionSnapshot, services }) {
    const { cdp, state, reply, urls, downloadsForSession } = services;
    if (command.reload === true) {
      if (command.url) throw new Error('navigate accepts url or reload=true, not both');
      await cdp.guestDebugger(guest);
      state.invalidateInteraction(guest);
      guest.reload();
      return actionSnapshot();
    }
    if (!command.url) throw new Error('navigate requires url or reload=true');
    const url = await urls.validatedAgentUrl(command.url || '');
    await cdp.guestDebugger(guest);
    state.invalidateInteraction(guest);
    const stopNavigation = () => {
      if (!guest.isDestroyed() && guest.isLoading()) {
        try { guest.stop(); } catch { /* teardown can race cancellation */ }
      }
    };
    signal?.addEventListener('abort', stopNavigation, { once: true });
    const load = guest.loadURL(url).catch(async (error: Error & { errno?: number }) => {
      // Aborted top-level loads (redirect chains, downloads) are not
      // failures of the command itself.
      if (/ERR_ABORTED/.test(String(error?.message))) return;
      if (/ERR_FAILED/.test(String(error?.message))) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (downloadsForSession(ownerSessionId).some((download) => download.url === url)) return;
          await pause(25, signal);
        }
      }
      throw error;
    });
    load.catch(() => undefined);
    try {
      const navigation = cdp.bounded(
        load,
        NAVIGATE_SETTLE_TIMEOUT_MS,
        'navigation',
        signal,
        stopNavigation,
      ).then(
        () => ({ done: true as const, error: null }),
        (error: unknown) => ({ done: true as const, error }),
      );
      for (;;) {
        const next = await Promise.race([
          navigation,
          pause(25, signal).then(() => ({ done: false as const, error: null })),
        ]);
        if (next.done) {
          if (next.error) throw next.error;
          break;
        }
        const dialog = reply.dialogResult(guest);
        if (dialog) return dialog;
      }
    } catch (error) {
      stopNavigation();
      if (signal?.aborted) throw error;
      pushBounded(state.for(guest).networkFailures, (error as Error).message);
      throw new Error(`navigation failed: ${redactBrowserText((error as Error).message)}`);
    } finally {
      signal?.removeEventListener('abort', stopNavigation);
    }
    const dialog = reply.dialogResult(guest);
    if (dialog) return dialog;
    return actionSnapshot();
  },

  async back(context) {
    return historyStep(context, 'back');
  },

  async forward(context) {
    return historyStep(context, 'forward');
  },
});

async function historyStep(
  { guest, actionSnapshot, services }: BrowserActionContext,
  direction: 'back' | 'forward',
): Promise<BrowserCommandResult> {
  const history = guest.navigationHistory;
  const can = direction === 'back' ? history.canGoBack() : history.canGoForward();
  if (!can) {
    return { text: `Cannot go ${direction}: no ${direction === 'back' ? 'earlier' : 'later'} history entry.` };
  }
  services.state.invalidateInteraction(guest);
  if (direction === 'back') history.goBack();
  else history.goForward();
  return actionSnapshot();
}
