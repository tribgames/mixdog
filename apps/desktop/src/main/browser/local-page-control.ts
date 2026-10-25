/**
 * A person's input on the pane's page: validated against the shown document,
 * then either applied at once or queued against agent commands on that page.
 */
import { browserInputImmediate, browserInputPresentation } from '../../shared/browser-input-policy';
import type { DesktopBrowserPageControl, DesktopBrowserTabControlResult } from '../../shared/contract';
import type { createBrowserGuestCdp } from './cdp';
import { COMMAND_TIMEOUT_MS } from './command';
import type { createBrowserCommandQueue } from './command-queue';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { browserLocalInputOptions } from './host-policy';
import type { createBrowserPageSurface } from './page-surface';
import { type BrowserSessionRegistry, browserSessionId } from './session-registry';
import { isSessionTabControl } from './tabs-close-result';
import type { WebContents } from 'electron';

type CommandQueue = ReturnType<typeof createBrowserCommandQueue>;

export function createBrowserLocalPageControl(options: {
  currentGuest: BrowserSessionRegistry['currentGuest'];
  state: BrowserGuestStateStore;
  retainGuest: (guest: WebContents) => void;
  queue: Pick<CommandQueue, 'executeLocal' | 'interruptForLocal' | 'holdLocal'>;
  control: ReturnType<typeof createBrowserPageSurface>['control'];
  bounded: ReturnType<typeof createBrowserGuestCdp>['bounded'];
}) {
  const { state, queue, control } = options;
  return (sessionId: string, input: DesktopBrowserPageControl): Promise<DesktopBrowserTabControlResult | void> => {
    const owner = browserSessionId(sessionId);
    // Showing a tab without picking it ("브라우저 · 보기", a pane following the
    // agent) needs no page of the pane's: it neither creates one, keeps one
    // for the user, nor stops the agent. A tab no longer open says so.
    if (input.type === 'select-tab' && input.follow) return control(owner, input);
    // Validate ownership before allowing an input to cancel this session's
    // automation. A stale frame must not take over a different document.
    const guest = options.currentGuest(owner);
    if (
      !guest ||
      guest.isDestroyed() ||
      (!isSessionTabControl(input) && input.documentId !== browserDocumentId(state, guest))
    ) {
      return Promise.reject(new Error('Browser page changed; input was not sent.'));
    }
    // A selected support tab keeps its own queue. Local takeover must
    // cancel the agent using that page, not the session's primary page.
    const command = { action: 'remote_control', session_id: owner, tab: state.pageId(guest) };
    if (input.type !== 'resize' && !(input.type === 'pointer' && input.phase === 'mouseMoved' && input.buttons === 0))
      options.retainGuest(guest);
    if (browserInputImmediate(input)) {
      if (input.type === 'answer-dialog' || input.type === 'choose-files') {
        const release = queue.holdLocal(command);
        // Human file selection has no tool-command deadline. The exact
        // document/prompt is revalidated after the native picker returns.
        return control(owner, input).finally(release);
      }
      if (!browserInputPresentation(input)) queue.interruptForLocal(command);
      const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
      return options.bounded(control(owner, input, signal), COMMAND_TIMEOUT_MS, 'Browser recovery control', signal);
    }
    // Dispatch itself remains bounded.
    return queue.executeLocal(command, (signal) => control(owner, input, signal), browserLocalInputOptions(input));
  };
}
