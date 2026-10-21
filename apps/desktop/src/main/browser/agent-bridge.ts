/**
 * Loopback command server + discovery file — the pair that exposes the
 * runtime's `browser` tool. Opt-in via Settings, mirroring Computer Use;
 * the pane infrastructure runs regardless of the toggle.
 */
import type { WebContents } from 'electron';
import { validateBrowserToolArgs } from '../../../../../src/runtime/browser-bridge/action-schema.mjs';
import { bridgeDiscoveryDirectory } from '../bridge/discovery-file';
import { BrowserBridgeServer } from './bridge-server';
import { BACKGROUND_RECLAIM_INTERVAL_MS, type BrowserCommand } from './command';
import { assertBrowserTaskCleanupContext, pendingSessionWork } from './host-policy';
import { redactBrowserText } from './redaction';
import { browserSessionId } from './session-registry';

export function createBrowserAgentBridge(options: {
  chains: Map<string, Promise<unknown>>;
  pendingReads: Map<string, Set<Promise<unknown>>>;
  execute: (command: BrowserCommand, signal: AbortSignal) => Promise<unknown>;
  /** Close a finished turn's temporary pages; returns how many closed. */
  finishTurn: (sessionId: string, turnId: number, options: { aborted: boolean }) => number;
  secretInput: (sessionId: string, requestId: string, signal: AbortSignal) => Promise<{ text: string }>;
  visibleGuests: () => WebContents[];
  lifecycle: {
    attachDebuggerEagerly(guest: WebContents): void;
    reclaimIdleBackgroundPages(): void;
    destroyAllBackgroundPages(): void;
  };
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
}) {
  const { chains, pendingReads, lifecycle } = options;
  let backgroundReclaimTimer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  const server = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: bridgeDiscoveryDirectory,
    execute: (command, signal) => {
      const { session_id, turn_id, internalStep, unattended_run, unattended_agent, ...input } = command;
      if (internalStep !== undefined) throw new Error('internalStep is not a bridge input');
      // Runtime-only lifecycle message: deliberately absent from tool schemas.
      if (command.action === 'finish_turn') {
        const owner = browserSessionId(session_id);
        assertBrowserTaskCleanupContext(session_id, turn_id, input as Record<string, unknown>);
        const aborted = (input as Record<string, unknown>).aborted === true;
        const pending = pendingSessionWork(`session:${owner}:`, chains, pendingReads);
        return Promise.allSettled(pending).then(() => ({
          text: `Browser task cleanup complete: ${options.finishTurn(owner, Number(turn_id), { aborted })} temporary page(s) closed.`,
        }));
      }
      // Runtime-only: fill the secret the user handed this desktop for the
      // request (secret-input.ts); the reply is 'provided' or 'skipped' only.
      if (command.action === 'secret_input') {
        const requestId = String((input as Record<string, unknown>).request_id || '');
        return options.secretInput(browserSessionId(session_id), requestId, signal);
      }
      const validated = validateBrowserToolArgs(input);
      if (!validated.ok) throw new Error(validated.error);
      return options.execute(
        {
          ...validated.input,
          action: validated.action,
          session_id,
          turn_id,
          // Runtime-set (client.mjs), outside the tool schema: a schedule/webhook run.
          ...(unattended_run === true ? { unattended_run: true, unattended_agent } : {}),
        },
        signal
      );
    },
    redactError: redactBrowserText,
    onReady: () => {
      options.onDiagnostic?.('browser-bridge-ready', {
        durationMs: startedAt > 0 ? Date.now() - startedAt : 0,
      });
      backgroundReclaimTimer = setInterval(
        () => lifecycle.reclaimIdleBackgroundPages(),
        BACKGROUND_RECLAIM_INTERVAL_MS
      );
      backgroundReclaimTimer.unref?.();
    },
    onInactive: () => {
      if (backgroundReclaimTimer) clearInterval(backgroundReclaimTimer);
      backgroundReclaimTimer = null;
    },
  });

  return {
    start(): void {
      startedAt = Date.now();
      options.onDiagnostic?.('browser-bridge-start', {});
      for (const guest of options.visibleGuests()) {
        lifecycle.attachDebuggerEagerly(guest);
      }
      server.start();
    },
    async stop(): Promise<void> {
      await server.stop();
      chains.clear();
      pendingReads.clear();
      // Agent-only surfaces die with the bridge; visible pane tabs belong to
      // the user and stay open — with their debugger, which is what keeps their
      // page dialogs in the pane rather than in OS dialog boxes.
      lifecycle.destroyAllBackgroundPages();
    },
  };
}
