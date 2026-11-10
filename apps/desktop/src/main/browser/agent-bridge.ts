/**
 * Loopback command server + discovery file — the pair that exposes the
 * runtime's `browser` tool. Opt-in via Settings, mirroring Computer Use;
 * the pane infrastructure runs regardless of the toggle.
 */
import type { WebContents } from 'electron';
import { validateBrowserToolArgs } from '../../shared/core-src/runtime/browser-bridge/action-schema.mjs';
import { bridgeDiscoveryDirectory } from '../bridge/discovery-file';
import { BrowserBridgeServer } from './bridge-server';
import { BACKGROUND_RECLAIM_INTERVAL_MS, type BrowserCommand } from './command';
import { assertBrowserTaskCleanupContext, pendingSessionWork } from './host-policy';
import { secretInputs } from '../secret-input';
import type { SecretFillValue } from './host-agent';
import type { SavedLoginHost } from './saved-login-host';
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

export interface BrowserCommandRunnerOptions {
  chains: Map<string, Promise<unknown>>;
  pendingReads: Map<string, Set<Promise<unknown>>>;
  execute: (command: BrowserCommand, signal: AbortSignal) => Promise<unknown>;
  /** Close a finished turn's temporary pages; returns how many closed. */
  finishTurn: (sessionId: string, turnId: number, options: { aborted: boolean }) => number;
  /** The session ran a turn or command: its pages belong to a live turn
   *  (`turnId` 0: a command with no turn id). */
  beginTurn: (sessionId: string, turnId: number) => void;
  /** The core's two-phase secret fill (host/browser/command `secret_precheck` / `secret_fill`). */
  secretFill: {
    precheck: (sessionId: string, requestId: string) => { text: string };
    fill: (sessionId: string, requestId: string, secret: SecretFillValue, signal: AbortSignal) => Promise<{ text: string }>;
  };
  /** Runtime-only: the saved-login value the core fills Computer Use with, for an admitted fill only. */
  savedLogin: SavedLoginHost;
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
}

/** The one command path of the `browser` tool: lifecycle messages, secret
 *  handoffs, schema validation and the secret-redacting guard. The loopback
 *  server and the host channel (`host/browser/command`) both run commands here. */
export function createBrowserCommandRunner(options: BrowserCommandRunnerOptions) {
  const { chains, pendingReads, lifecycle } = options;
  const guarded = (
    command: BrowserCommand,
    signal: AbortSignal,
    run: (command: BrowserCommand, signal: AbortSignal) => unknown
  ) => guardBrowserSecrets(command, signal, run, options.redactSecrets);
  let backgroundReclaimTimer: NodeJS.Timeout | null = null;
  let startedAt = 0;
  const stopReclaimTimer = (): void => {
    if (backgroundReclaimTimer) clearInterval(backgroundReclaimTimer);
    backgroundReclaimTimer = null;
  };
  const ready = (): void => {
    options.onDiagnostic?.('browser-bridge-ready', {
      durationMs: startedAt > 0 ? Date.now() - startedAt : 0,
    });
    stopReclaimTimer();
    backgroundReclaimTimer = setInterval(() => lifecycle.reclaimIdleBackgroundPages(), BACKGROUND_RECLAIM_INTERVAL_MS);
    backgroundReclaimTimer.unref?.();
  };
  const runner = {
    execute: (command: BrowserCommand, signal: AbortSignal): Promise<unknown> =>
      guarded(command, signal, (command, signal) => {
        const {
          session_id,
          turn_id,
          internalStep,
          unattended_run,
          unattended_agent,
          session_life,
          mail_link,
          ...input
        } = command;
        if (internalStep !== undefined) throw new Error('internalStep is not a bridge input');
        // Runtime-only lifecycle messages: deliberately absent from tool schemas.
        if (command.action === 'begin_turn') {
          assertBrowserTaskCleanupContext(session_id, turn_id, input as Record<string, unknown>);
          options.beginTurn(browserSessionId(session_id), Number(turn_id));
          return { text: 'Browser turn started.' };
        }
        // Every other command, list_tabs and status included, is activity.
        if (command.action !== 'finish_turn') options.beginTurn(browserSessionId(session_id), Number(turn_id) || 0);
        if (command.action === 'finish_turn') {
          const owner = browserSessionId(session_id);
          assertBrowserTaskCleanupContext(session_id, turn_id, input as Record<string, unknown>);
          const aborted = (input as Record<string, unknown>).aborted === true;
          const pending = pendingSessionWork(`session:${owner}:`, chains, pendingReads);
          return Promise.allSettled(pending).then(() => ({
            text: `Browser task cleanup complete: ${options.finishTurn(owner, Number(turn_id), { aborted })} temporary page(s) closed.`,
          }));
        }
        // Runtime-only, from the core that holds the user's value: check the bound page with no value
        // on the wire (`secret_precheck`), then fill it (`secret_fill`); each answers its outcome only.
        if (command.action === 'secret_precheck' || command.action === 'secret_fill') {
          const fields = input as Record<string, unknown>;
          const requestId = String(fields.request_id || '');
          if (command.action === 'secret_precheck') return options.secretFill.precheck(browserSessionId(session_id), requestId);
          const secret = { value: String(fields.value ?? ''), username: String(fields.username ?? ''), save: fields.save === true };
          return options.secretFill.fill(browserSessionId(session_id), requestId, secret, signal);
        }
        // Runtime-only, from the core that runs a Computer Use saved-login fill: admit the fill, hand over its
        // one value (exact origin, admitted fill only), release it when its turn settles.
        if (command.action === 'saved_login_admit') return options.savedLogin.admit(browserSessionId(session_id), input as Record<string, unknown>);
        if (command.action === 'saved_login_release') return options.savedLogin.release(browserSessionId(session_id), input as Record<string, unknown>);
        if (command.action === 'saved_login_check') return options.savedLogin.check(browserSessionId(session_id), input as Record<string, unknown>);
        if (command.action === 'saved_login_type') return options.savedLogin.type(browserSessionId(session_id), input as Record<string, unknown>);
        if (command.action === 'saved_login_value') return options.savedLogin.value(browserSessionId(session_id), input as Record<string, unknown>);
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
            // Runtime-set (client.mjs): the session's life, for "allow for this session".
            ...(typeof session_life === 'string' && session_life ? { session_life } : {}),
            // Runtime-set (mail-links.mjs), outside the tool schema: a navigate URL
            // the runtime read in a mail; url-policy.ts checks it against the URL.
            ...(mail_link !== undefined ? { mail_link } : {}),
          },
          signal
        );
      }),
    /** Begin serving: attach debuggers to visible pages; `ready` arms the idle reclaim. */
    begin(): void {
      startedAt = Date.now();
      options.onDiagnostic?.('browser-bridge-start', {});
      for (const guest of options.visibleGuests()) {
        lifecycle.attachDebuggerEagerly(guest);
      }
    },
    ready,
    inactive: stopReclaimTimer,
    end(): void {
      chains.clear();
      pendingReads.clear();
      // Agent-only surfaces die with the bridge; visible pane tabs belong to
      // the user and stay open — with their debugger, which is what keeps their
      // page dialogs in the pane rather than in OS dialog boxes.
      lifecycle.destroyAllBackgroundPages();
    },
  };
  return runner;
}

export function createBrowserAgentBridge(options: BrowserCommandRunnerOptions) {
  const runner = createBrowserCommandRunner(options);
  const server = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: bridgeDiscoveryDirectory,
    execute: runner.execute,
    redactError: redactBrowserText,
    onReady: runner.ready,
    onInactive: runner.inactive,
  });
  return {
    runner,
    start(): void {
      runner.begin();
      server.start();
    },
    async stop(): Promise<void> {
      await server.stop();
      runner.end();
    },
  };
}
