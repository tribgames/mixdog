import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import type { BrowserWindow, WebContents } from 'electron';
import { DESKTOP_IPC } from '../../shared/contract-ipc';
import { withHumanOnlyApproval } from '../human-only-approval';
import {
  browserNotApproved,
  originOfUrl,
  type BrowserApprovalKind,
  type BrowserApprovalRequest,
} from './action-approval';
import { type ApprovalRequester, ownBotOfSession } from './approval-requester';
import { redactBrowserUrl } from './redaction';

/** Approvals wait here for the in-app card's answer (never an OS dialog),
 *  keyed to the one renderer the card was sent to. */
type Decision = 'once' | 'always' | 'deny';
const pending = new Map<
  string,
  { owner: WebContents; sessionIds: string[]; finish: (decision: Decision, reason?: string) => void }
>();

/** The store action (human-gate ACTION_KINDS) a standing allow is kept under,
 *  per kind of gated step. `confirm` has none: it always asks. */
const GRANT_ACTION: Partial<Record<BrowserApprovalKind, string>> = {
  submit: 'browser_submit',
  post: 'browser_post',
  upload: 'browser_upload',
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** An upload's files for the card: name, full path, size, and whether the file
 *  lies outside the session's working directory and Downloads. Unknown (no
 *  working directory) is not marked. */
async function cardFiles(files: Array<{ path: string; size: number }>, cwd: string, downloads: string) {
  const roots = await Promise.all([cwd, downloads].filter(Boolean).map((root) => realpath(root).catch(() => root)));
  return files.map(({ path, size }) => ({
    name: basename(path),
    path,
    size,
    outside: cwd ? !roots.some((root) => inside(root, path)) : false,
  }));
}

/** The store actions of the kinds that have one (`confirm` has none): what a
 *  bot's `block` is read for under "Allow all actions", and what its audit names. */
const kindActions = (kinds: readonly BrowserApprovalKind[]): string[] =>
  kinds.map((kind) => GRANT_ACTION[kind]).filter((action): action is string => Boolean(action));

/** The actions a standing allow would cover, or null when any of the request's
 *  kinds can never have one (then the card offers only once / deny). */
function grantActions(kinds: readonly BrowserApprovalKind[]): string[] | null {
  const actions = kinds.map((kind) => GRANT_ACTION[kind]);
  return actions.length > 0 && actions.every((action): action is string => Boolean(action)) ? actions : null;
}

/** The sessions with a card waiting (the asking session and the chat it docks
 *  in), told to `hooks.onPendingSessions` on every change. */
function pendingSessionIds(): string[] {
  return [...new Set([...pending.values()].flatMap((entry) => entry.sessionIds))];
}
const publishPendingSessions = (): void => {
  try {
    hooks.onPendingSessions?.(pendingSessionIds());
  } catch {
    /* a lost mark never decides an approval */
  }
};

export interface BrowserApprovalHooks {
  /** The asking session's display name and working directory; empty when
   *  unknown. Never decides whether the session asks (that is its id). */
  resolveRequester?(sessionId: string): Promise<ApprovalRequester>;
  /** Whether `agentId` has a standing allow for every one of `actions`. */
  isAllowed?(agentId: string, actions: string[]): Promise<boolean>;
  /** Whether `agentId`'s mode is `block` for any of `actions`. */
  isBlocked?(agentId: string, actions: string[]): Promise<boolean>;
  /** Record a standing allow for `agentId` for each of `actions`. */
  remember?(agentId: string, actions: string[]): Promise<void>;
  /** Whether the "Allow all actions" developer option is on (Settings →
   *  Developer; the runtime's `developer.allowAllActions`). */
  allowAllActions?(): Promise<boolean>;
  /** Audit line: `approve` / `deny` (the card), `granted` (always allow saved),
   *  `remembered` (a saved allow let it run unasked), `run-allowed` (a
   *  schedule/webhook run did it unasked), `dev-allow-all` (the developer
   *  option did), `blocked` (the bot's block stopped a step). */
  audit?(agentId: string, actions: string[], decision: string): Promise<void>;
  /** The user's Downloads folder: an upload from it is not marked "outside the project". */
  downloadsDir?(): string;
  /** An approval opened while the window is not focused: show an app
   *  notification whose click opens that session. Never takes focus itself. */
  notify?(window: BrowserWindow, requester: { sessionId: string; name: string }): void;
  /** The top-level chat a session's card docks in (a sub-agent's root chat). */
  surfaceSessionId?(sessionId: string): string;
  /** Every session with a card waiting, after each change (empty once none
   *  waits): paired devices mark them. Ids only; the card stays on this PC. */
  onPendingSessions?(sessionIds: string[]): void;
}
let hooks: BrowserApprovalHooks = {};

export function setBrowserApprovalHooks(next: BrowserApprovalHooks): void {
  hooks = next;
}

const REQUESTER_TIMEOUT_MS = 1_500;
const UNKNOWN_REQUESTER: ApprovalRequester = { name: '' };

async function requesterOf(sessionId: string): Promise<ApprovalRequester> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!hooks.resolveRequester) return UNKNOWN_REQUESTER;
    return await Promise.race([
      hooks.resolveRequester(sessionId),
      new Promise<ApprovalRequester>((resolve) => {
        timer = setTimeout(() => resolve(UNKNOWN_REQUESTER), REQUESTER_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return UNKNOWN_REQUESTER;
  } finally {
    clearTimeout(timer);
  }
}

/** The renderer card's answer (`once`, `always`, `deny`; anything else denies).
 *  Only the renderer the card was sent to can answer it; an unknown, settled
 *  or foreign id is ignored. `always` stores a grant only for a bot's own
 *  card; where none was offered (no bot) it is a single allow.
 *  A denial may carry the person's note for the asking agent. */
export function decideBrowserApproval(sender: WebContents, id: unknown, decision: unknown, reason?: unknown): void {
  if (typeof id !== 'string') return;
  const entry = pending.get(id);
  if (entry?.owner !== sender) return;
  if (decision === 'always') entry.finish('always');
  else if (decision === 'once') entry.finish('once');
  else entry.finish('deny', typeof reason === 'string' ? reason.trim().slice(0, 4_000) : '');
}

/** Whether `agentId` already holds a standing allow for all of `actions`; a
 *  store that cannot answer means "ask". */
async function standingAllow(agentId: string, actions: string[]): Promise<boolean> {
  try {
    return (await hooks.isAllowed?.(agentId, actions)) === true;
  } catch {
    return false;
  }
}

/** Whether `agentId` has blocked any of `actions`; a store that cannot answer
 *  means blocked (a run must not act on a permission it could not read). */
async function blockedBy(agentId: string, actions: string[]): Promise<boolean> {
  try {
    return hooks.isBlocked ? (await hooks.isBlocked(agentId, actions)) === true : false;
  } catch {
    return true;
  }
}

/** Whether the "Allow all actions" option is on; a store that cannot answer means "ask". */
async function allowsAllActions(): Promise<boolean> {
  try {
    return (await hooks.allowAllActions?.()) === true;
  } catch {
    return false;
  }
}

const BLOCKED_BY_PERMISSION = "Browser Use step blocked by this bot's permission; nothing was dispatched";

export async function requestBrowserApproval(
  window: BrowserWindow,
  request: BrowserApprovalRequest,
  signal?: AbortSignal
): Promise<boolean> {
  // A standing allow is per bot (its own home chat or room seat, one grant
  // for both) and per kind of step: a command is let through unasked only when
  // this bot holds one for EVERY kind it contains, and never for a kind that
  // always asks. The bot is read from the session id alone (ownBotOfSession):
  // a failed or slow requester lookup never turns a bot's session into one
  // that runs unasked. Nothing else (a sub-agent, a task session, a coding
  // session) has a bot, and it runs without a card.
  const ownBot = ownBotOfSession(request.sessionId);
  if (!ownBot && request.unattended !== true) return !signal?.aborted;
  const requester = await requesterOf(request.sessionId);
  const actions = grantActions(request.kinds);
  const bot = actions ? ownBot : '';
  const audit = (decision: string) => {
    if (bot && actions) void (async () => hooks.audit?.(bot, actions, decision))().catch(() => undefined);
  };
  // A schedule or webhook run (and the work it started) never asks: saving the
  // routine was the user's grant. The bot's own `block` still applies, and an
  // operator-confirmed action (`confirm`) always asks.
  if (request.unattended === true && !request.kinds.includes('confirm')) {
    // The run's owning bot is the one recorded for the run (never the
    // requester, whose lookup can time out or name no bot for a task session).
    // Without it, or without a readable permission, the step is refused.
    const owner = (request.unattendedAgent || '').trim();
    const runAudit = (decision: string) => {
      if (owner && actions) void (async () => hooks.audit?.(owner, actions, decision))().catch(() => undefined);
    };
    if (!owner) {
      throw new Error(
        "Browser Use step refused: the run's owning bot could not be established; nothing was dispatched"
      );
    }
    if (actions && (!hooks.isBlocked || (await blockedBy(owner, actions)))) {
      runAudit('blocked');
      throw new Error(BLOCKED_BY_PERMISSION);
    }
    runAudit('run-allowed');
    return !signal?.aborted;
  }
  // "Allow all actions" in a bot's own session (never a run: that keeps its
  // rule above): the bot's submits, posts and uploads run unasked, and so does
  // an operator `confirm`, which is never remembered. The bot's `block` still
  // stops the step, read for every kind of it that has a store action.
  if (ownBot && request.unattended !== true && (await allowsAllActions())) {
    const stepActions = kindActions(request.kinds);
    const auditAs = (decision: string) => {
      if (stepActions.length) {
        void (async () => hooks.audit?.(ownBot, stepActions, decision))().catch(() => undefined);
      }
    };
    if (stepActions.length && (await blockedBy(ownBot, stepActions))) {
      auditAs('blocked');
      throw new Error(BLOCKED_BY_PERMISSION);
    }
    auditAs('dev-allow-all');
    return !signal?.aborted;
  }
  if (bot && actions && (await standingAllow(bot, actions))) {
    audit('remembered');
    return !signal?.aborted;
  }
  // The card waits until the person answers: no timer ends it. Deny, the
  // command being stopped (`signal`, also while the approval is still queued
  // behind another card) and the card's document going away settle it.
  const asked = withHumanOnlyApproval(async () => {
    if (signal?.aborted || window.isDestroyed() || window.webContents.isDestroyed()) return false;
    const contents = window.webContents;
    const id = randomUUID();
    const files = request.files
      ? await cardFiles(request.files, requester.cwd || '', hooks.downloadsDir?.() || '')
      : [];
    const send = (payload: unknown) => {
      if (!window.isDestroyed() && !contents.isDestroyed()) contents.send(DESKTOP_IPC.browserApproval, payload);
    };
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      // The card lives in this renderer document: leaving it (reload,
      // navigation, crash, teardown) denies, so the human-only lock is freed.
      const onDocumentGone = () => finish('deny');
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) finish('deny');
      };
      const finish = (decision: Decision, reason = '') => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onDocumentGone);
        contents.removeListener('did-start-navigation', onNavigation as never);
        contents.removeListener('render-process-gone', onDocumentGone);
        contents.removeListener('destroyed', onDocumentGone);
        window.removeListener('closed', onDocumentGone);
        pending.delete(id);
        publishPendingSessions();
        send({ id, closed: true });
        // The person's note reaches the agent as the command's error.
        if (decision === 'deny' && reason) reject(new Error(browserNotApproved(reason)));
        else resolve(decision !== 'deny');
        audit(decision === 'deny' ? 'deny' : 'approve');
        if (decision === 'always' && bot && actions) {
          // Not saved (store unreachable): this action ran once, the next asks
          // again, and the person is told so.
          void (async () => hooks.remember?.(bot, actions))().then(
            () => audit('granted'),
            () => send({ id, saveFailed: true })
          );
        }
      };
      const surfaceSessionId = hooks.surfaceSessionId?.(request.sessionId) || request.sessionId;
      pending.set(id, { owner: contents, sessionIds: [surfaceSessionId, request.sessionId], finish });
      publishPendingSessions();
      signal?.addEventListener('abort', onDocumentGone, { once: true });
      contents.on('did-start-navigation', onNavigation as never);
      contents.on('render-process-gone', onDocumentGone);
      contents.once('destroyed', onDocumentGone);
      window.once('closed', onDocumentGone);
      send({
        id,
        action: request.action,
        url: redactBrowserUrl(request.url),
        sessionId: request.sessionId,
        surfaceSessionId,
        agentId: ownBot,
        requester: requester.name || ownBot,
        target: request.target,
        paths: request.paths,
        ...(files.length
          ? { origin: originOfUrl(request.url), receiverOrigin: request.receiverOrigin || '', files }
          : {}),
        // What "always allow" would change, or why this one only asks once.
        remember: bot ? { kinds: request.kinds } : null,
      });
      if (!window.isDestroyed() && !window.isFocused()) {
        hooks.notify?.(window, { sessionId: request.sessionId, name: requester.name || ownBot });
      }
    });
  }, signal);
  // A command stopped while queued behind another card is a denial, not an error.
  return asked.catch((error) => {
    if (signal?.aborted) return false;
    throw error;
  });
}
