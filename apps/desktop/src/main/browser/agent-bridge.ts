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
import { secretInputs } from '../secret-input';
import { redactBrowserText } from './redaction';
import { browserSessionId } from './session-registry';

/** The runtime-only handoff facts (browser-bridge client.mjs browserHandoffPage). */
const HANDOFF_PAGE_ACTIONS = new Set(['secret_bind', 'login_accounts', 'page_url']);

/** The one place browser results leave the desktop for the runtime: whatever
 *  the host filled into a page this session (a password, a one-time code, an
 *  ask_user or agent-typed secret; secret-input.ts — never a username, which
 *  the agent may read, e.g. "signed in as …") is replaced by a fixed marker in the
 *  reply's text and in an error's message — page text, snapshots, evaluate
 *  results, console and network output all travel in them. */
export async function guardBrowserSecrets(
  command: BrowserCommand,
  signal: AbortSignal,
  run: (command: BrowserCommand, signal: AbortSignal) => unknown,
  redact: (sessionId: string, text: string) => string = (sessionId, text) => secretInputs.redact(sessionId, text)
): Promise<unknown> {
  const owner = browserSessionId(command.session_id);
  try {
    const value = await run(command, signal);
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
      const reply = value as { text: string };
      reply.text = redact(owner, reply.text);
    }
    return value;
  } catch (error) {
    const original = (error as Error)?.message || String(error);
    const message = redact(owner, original);
    if (message !== original) throw new Error(message);
    throw error;
  }
}

export function createBrowserAgentBridge(options: {
  chains: Map<string, Promise<unknown>>;
  pendingReads: Map<string, Set<Promise<unknown>>>;
  execute: (command: BrowserCommand, signal: AbortSignal) => Promise<unknown>;
  /** Close a finished turn's temporary pages; returns how many closed. */
  finishTurn: (sessionId: string, turnId: number, options: { aborted: boolean }) => number;
  secretInput: (sessionId: string, requestId: string, signal: AbortSignal) => Promise<{ text: string }>;
  /** Runtime-only ask_user handoff facts (host-agent.ts HANDOFF_PAGE_ACTIONS). */
  handoffPage: (
    sessionId: string,
    action: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>;
  visibleGuests: () => WebContents[];
  lifecycle: {
    attachDebuggerEagerly(guest: WebContents): void;
    reclaimIdleBackgroundPages(): void;
    destroyAllBackgroundPages(): void;
  };
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  /** Test seam: the session's filled-secret redaction (secretInputs by default). */
  redactSecrets?: (sessionId: string, text: string) => string;
}) {
  const { chains, pendingReads, lifecycle } = options;
  const guarded = (
    command: BrowserCommand,
    signal: AbortSignal,
    run: (command: BrowserCommand, signal: AbortSignal) => unknown
  ) => guardBrowserSecrets(command, signal, run, options.redactSecrets);
  let backgroundReclaimTimer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  const server = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: bridgeDiscoveryDirectory,
    execute: (command, signal) => guarded(command, signal, (command, signal) => {
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
      // Runtime-only: bind a secret request to its page, list a sign-in page's
      // masked saved logins, or say where a page is now; no value moves.
      if (HANDOFF_PAGE_ACTIONS.has(String(command.action))) {
        return options.handoffPage(
          browserSessionId(session_id),
          String(command.action),
          input as Record<string, unknown>,
          signal
        );
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
    }),
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
