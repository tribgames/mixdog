/**
 * The agent's command path: the services every action reads, the runner that
 * admits a command to its page, the per-page queue it waits in, and the
 * bridge that receives commands from the runtime's `browser` tool.
 */
import type { WebContents } from 'electron';

import type { BrowserActionServices } from './actions';
import { type BrowserAutoSignInDeps, createBrowserAutoSignIn, httpsOrigin } from './auto-sign-in';
import { createBrowserAgentBridge } from './agent-bridge';
import { type BrowserCommand, COMMAND_TIMEOUT_MS, READ_ONLY_ACTIONS } from './command';
import { ownBotOfSession } from './approval-requester';
import { browserDocumentId } from './guest-state';
import { createBrowserCommandQueue } from './command-queue';
import { createBrowserCommandRunner } from './command-runner';
import type { createBrowserCommandToolkit } from './command-toolkit';
import { BrowserPageChangedError, type BrowserCredentialFillResult } from './credential-autofill';
import type { createBrowserGuestLifecycle } from './guest-lifecycle';
import type { BrowserHostFoundation } from './host-foundation';
import { LINKED_FIELD_READ, type LinkedFieldFacts } from './linked-sign-in';
import type { BrowserProfileImportService } from './profile-import';
import { browserSessionId } from './session-registry';
import type { createBrowserTabs } from './tabs';
import { createBrowserTargetResolver } from './target-resolve';
import type { createBrowserTaskLifecycle } from './task-lifecycle';
import { takeoverGate } from '../takeover-gate';
import {
  SECRET_SAVE_SUFFIX,
  SECRET_USERNAME_SUFFIX,
  type SecretFillOutcome,
  secretInputs,
  type SecretInputs,
} from '../secret-input';

type Toolkit = ReturnType<typeof createBrowserCommandToolkit>;

/** Fill an account's stored credential into the page it was asked for, never
 *  into one the guest navigated to meanwhile. An explicit fill the form took
 *  records the account as last used (vault metadata, never a secret), so it
 *  ranks first for the site's next auto sign-in. */
function storedCredentialFill(
  profileImporter: BrowserProfileImportService,
  fillCredentialInGuest: Toolkit['credentialFill']['fillCredentialInGuest'],
  recordUsed: (id: string) => Promise<void> = vaultSignInHooks.markUsed
): BrowserActionServices['credentials']['fillStored'] {
  return (guest, account, signal) => {
    signal?.throwIfAborted();
    const url = guest.getURL();
    return profileImporter.useCredentialByAccount(
      url,
      account,
      async (credential, id) => {
        signal?.throwIfAborted();
        if (guest.isDestroyed() || guest.getURL() !== url) {
          throw new Error('The page changed before stored credential input; input was not sent.');
        }
        const result = await fillCredentialInGuest(guest, credential, signal, url);
        // The password is in the form: a failed metadata write changes nothing for the reply.
        if (result.passwordFilled) await recordUsed(id).catch(() => undefined);
        return result;
      },
      signal
    );
  };
}

/** Save a sign-in typed in chat as this site's login (credential-vault.ts).
 *  Loaded on use: the vault reads Electron's safe storage. */
async function saveChatLogin(login: { origin: string; username: string; password: string }): Promise<void> {
  const vault = await import('./credential-vault');
  await vault.upsertVaultLogin({ ...login, source: 'chat' });
}

/** One secret the user typed into the card, filled into exactly the elements
 *  of the page the request was bound to (secret_bind) — never the selected
 *  tab, the focused field or another one — and only while that page shows
 *  the main-frame document it showed then (a navigation, even within the
 *  origin, retires the binding) on the same https origin, through the
 *  isolated-world fill (which keeps it registered for redaction). The
 *  session's own takeover lock is checked before the value is taken; every
 *  refusal (blocked, page changed, no field) drops the request's slots and
 *  binding unused, answers only its outcome, and the value is taken at most
 *  once and never logged. A sign-in the user chose to save is stored for the
 *  origin after it was entered. */
export async function fillSecretInput(
  host: {
    pageById(sessionId: string, pageId: string): WebContents | null | undefined;
    fill: Toolkit['credentialFill']['fillSecretField'];
    assertFree?: (sessionId: string) => void;
    saveLogin?: (login: { origin: string; username: string; password: string }) => Promise<void>;
  },
  sessionId: string,
  requestId: string,
  signal?: AbortSignal,
  registry: SecretInputs = secretInputs
): Promise<{ text: SecretFillOutcome }> {
  const binding = registry.binding(requestId);
  if (!registry.has(requestId)) {
    registry.discard(requestId);
    return { text: 'expired' };
  }
  if (!binding || binding.sessionId !== sessionId) {
    registry.discard(requestId);
    return { text: 'blocked' };
  }
  try {
    (host.assertFree || ((id: string) => takeoverGate.assertFree(id)))(sessionId);
  } catch {
    registry.discard(requestId);
    return { text: 'blocked' };
  }
  const guest = host.pageById(sessionId, binding.pageId);
  const onOrigin = (page: WebContents) => !page.isDestroyed() && httpsOrigin(page.getURL()) === binding.origin;
  if (!guest || !onOrigin(guest) || !binding.document) {
    registry.discard(requestId);
    return { text: 'page_changed' };
  }
  if (!binding.targets?.length) {
    registry.discard(requestId);
    return { text: 'no_field' };
  }
  const value = registry.take(requestId);
  const username = registry.take(requestId + SECRET_USERNAME_SUFFIX);
  const save = registry.take(requestId + SECRET_SAVE_SUFFIX) === '1';
  registry.discard(requestId);
  try {
    const result = await host.fill(
      guest,
      { form: binding.form, value, username, targets: binding.targets, document: binding.document },
      signal
    );
    // A bound element gone or changed (stale) is no field: nothing was typed.
    if (!result.filled) return { text: 'no_field' };
    if (save && binding.form === 'login' && username) {
      await (host.saveLogin || saveChatLogin)({ origin: binding.origin, username, password: value }).catch((error) =>
        console.warn('[secret-input] saving the chat login failed:', (error as Error)?.message || error)
      );
    }
    return { text: 'entered' };
  } catch (error) {
    return { text: error instanceof BrowserPageChangedError || !onOrigin(guest) ? 'page_changed' : 'blocked' };
  }
}

/** How long a login takeover's saved-login binding lasts: past the
 *  takeover's own 15-minute expiry (takeover-gate.ts). */
const LOGIN_FILL_BINDING_MS = 16 * 60_000;

/** The login card's saved-login fill (ApprovalCard 이 계정으로 로그인): the
 *  stored login `credentialId` goes into the page the takeover was bound to
 *  at request time (handoffPageFacts login_accounts), never the selected tab,
 *  and only while that page still shows the main-frame document it showed
 *  then (a navigation, even within the origin, retires the binding). The
 *  page's address is checked before the vault is read, again once it was
 *  read, and before every dispatch of the isolated fill, which is held to
 *  that address and to the bound document (credential-autofill.ts
 *  openIsolatedWorld): a navigation meanwhile sends nothing to the new page.
 *  The password and username go only into the elements bound at request time
 *  (fillSecretField, as an ask_user secret does): a focus change or a
 *  replaced form leaves them stale, and nothing is typed.
 *  A sign-in with two steps: a request on a username-only page binds the
 *  username field alone, and its fill types the username only (`usernameFilled`,
 *  no `passwordFilled`: the takeover stays open). Each step binds its own
 *  page's fields: a username-step binding is re-bound (host.inspect, pinned to
 *  the document it reads, same session, page and https origin) when the user
 *  picks the login again, and fills the password page's field if that is what
 *  the page shows now. */
export async function fillBoundLogin(
  host: {
    pageById(sessionId: string, pageId: string): WebContents | null | undefined;
    useCredential: BrowserProfileImportService['useCredential'];
    fill: Toolkit['credentialFill']['fillSecretField'];
    inspect?: Toolkit['credentialFill']['inspectSecretField'];
  },
  sessionId: string,
  fillId: string,
  credentialId: string,
  signal?: AbortSignal,
  registry: SecretInputs = secretInputs
): Promise<BrowserCredentialFillResult> {
  const binding = registry.binding(fillId);
  const guest =
    binding?.sessionId === sessionId && binding.form === 'login' ? host.pageById(sessionId, binding.pageId) : null;
  const url = guest && !guest.isDestroyed() ? guest.getURL() : '';
  // A refusal is an answer the card words itself, never a raw error.
  const pageChanged: BrowserCredentialFillResult = {
    usernameFilled: false,
    passwordFilled: false,
    reason: 'page-changed',
  };
  if (!guest || !binding?.document || httpsOrigin(url) !== binding.origin) return pageChanged;
  // Bound to no element at request time: nothing to fill.
  const unfillable: BrowserCredentialFillResult = {
    usernameFilled: false,
    passwordFilled: false,
    reason: 'password-field-unavailable',
  };
  if (!binding.targets?.length) return unfillable;
  const stillAt = () => !guest.isDestroyed() && guest.getURL() === url;
  let result: BrowserCredentialFillResult;
  try {
    let { targets, document } = binding;
    if (targets[0].type !== 'password' && host.inspect) {
      // The username step's binding: this click binds the page it is on now.
      const info = await host.inspect(guest, { form: 'login' }, signal);
      if (!stillAt()) throw new BrowserPageChangedError();
      if (!info.document || !info.targets?.length) return unfillable;
      ({ targets, document } = { targets: info.targets, document: info.document });
      registry.bind(fillId, { ...binding, document, targets }, LOGIN_FILL_BINDING_MS);
    }
    const passwordStep = targets[0].type === 'password';
    result = await host.useCredential(
      url,
      credentialId,
      async (credential) => {
        signal?.throwIfAborted();
        if (!stillAt()) throw new BrowserPageChangedError();
        // Only the elements bound for this step are written; a bound element
        // gone or changed (stale) fills nothing.
        const filled = await host.fill(
          guest,
          passwordStep
            ? { form: 'login', value: credential.password, username: credential.username, targets, document, url }
            : { form: 'username', value: credential.username, targets, document, url },
          signal
        );
        return passwordStep
          ? {
              usernameFilled: filled.usernameFilled === true,
              passwordFilled: filled.filled,
              ...(filled.filled ? {} : { reason: 'password-field-unavailable' as const }),
            }
          : {
              usernameFilled: filled.filled,
              passwordFilled: false,
              ...(filled.filled ? {} : { reason: 'password-field-unavailable' as const }),
            };
      },
      signal
    );
  } catch (error) {
    // The page moved while the login was read or on its way (the fill
    // refuses then): said as such. Anything else stays an error.
    if (!signal?.aborted && (error instanceof BrowserPageChangedError || !stillAt())) return pageChanged;
    throw error;
  }
  if (result.passwordFilled) registry.discard(fillId);
  return result;
}

type VaultAccounts = BrowserAutoSignInDeps['suggestions'];

/** What auto sign-in reads and writes in the vault besides its accounts. */
interface VaultSignInHooks {
  /** Remember `id` as the site's last used login. */
  markUsed(id: string): Promise<void>;
  /** The current one-time code of `id` for `url`'s origin ('' without a key). */
  totpCode(id: string, url: string): Promise<string>;
}

/** The vault's logins auto sign-in may use for an origin, the one to use
 *  first at the head (credential-vault.ts preferredAccountsFor). Loaded on
 *  use, like saveChatLogin: the vault reads Electron's safe storage. */
const vaultAccounts: VaultAccounts = (url, prefilled) =>
  import('./credential-vault').then((vault) => vault.vaultAutoSignInAccounts(url, prefilled));

const vaultSignInHooks: VaultSignInHooks = {
  markUsed: (id) => import('./credential-vault').then((vault) => vault.markVaultLoginUsed(id)),
  totpCode: (id, url) => import('./credential-vault').then((vault) => vault.vaultTotpCode(id, url)),
};

/** What auto sign-in (auto-sign-in.ts) works with. Its accounts are the
 *  vault's auto-sign-in logins only, so an origin signed out here (paused) or
 *  deleted never signs in by itself; the manual fill and the login card keep
 *  the full saved-login list. Its Enter goes through the bot's browser
 *  approval policy as the form submit it is, with the saved login as the
 *  user's consent: a policy that would only ask lets it through (the request
 *  is made as an unattended run of the page owner's bot, so only the bot's
 *  block, a denied action or an operator confirm applies), and a block or
 *  denial throws and hands the sign-in to the user. */
export function browserAutoSignInDeps(
  base: Pick<BrowserHostFoundation, 'profileImporter' | 'documents' | 'state' | 'approvals' | 'sessions'>,
  tools: Pick<Toolkit, 'credentialFill' | 'input'>,
  enabled: () => boolean,
  accounts: VaultAccounts = vaultAccounts,
  vault: VaultSignInHooks = vaultSignInHooks,
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void
): BrowserAutoSignInDeps {
  return {
    onDiagnostic,
    enabled,
    suggestions: (url, prefilled) => accounts(url, prefilled),
    withCredential: (url, id, use, signal) => base.profileImporter.useCredential(url, id, use, signal),
    document: (guest, signal) => tools.credentialFill.pageDocument(guest, signal),
    fill: (guest, credential, signal, step, document) =>
      tools.credentialFill.fillCredentialInGuest(guest, credential, signal, '', step === 'username', document),
    submit: (guest, signal, beforeDispatch) => tools.input.pressKey(guest, 'enter', signal, beforeDispatch),
    // The asking session is the page's owner: the bot and its policy are read
    // from it (approval-dialog.ts ownBotOfSession), so it is never left blank.
    approveSubmit: (guest, signal) => {
      const sessionId = base.sessions.sessionIdForGuest(guest) || '';
      const owner = ownBotOfSession(sessionId);
      return base.approvals
        .approve(
          {
            action: 'press',
            key: 'enter',
            submit: true,
            session_id: sessionId,
            ...(owner ? { unattended_run: true, unattended_agent: owner } : {}),
          } as BrowserCommand,
          () => ({ url: guest.getURL(), identity: browserDocumentId(base.state, guest) }),
          signal
        )
        .then(() => undefined);
    },
    recordUsed: (_url, id) => vault.markUsed(id),
    code: {
      value: (url, id) => vault.totpCode(id, url),
      // The code field is bound on this very page, then written (as an
      // ask_user one-time code is); the value is remembered for redaction.
      fill: async (guest, code, signal, boundUrl, document) => {
        const field = tools.credentialFill;
        const info = await field.inspectSecretField(guest, { form: 'otp' }, signal);
        // Bound to the document the step was read on, as every automatic step is.
        if (info.form !== 'otp' || !info.targets?.length || !info.document) return false;
        if (document && info.document !== document) throw new BrowserPageChangedError();
        const result = await field.fillSecretField(
          guest,
          { form: 'otp', value: code, targets: info.targets, document: info.document, url: boundUrl },
          signal
        );
        return result.filled;
      },
    },
    collect: (guest, expression, signal) => base.documents.collect(guest, expression, signal),
    invalidate: (guest) => base.state.invalidateInteraction(guest),
  };
}

/** The page an ask_user handoff is about: the named page of the session, else
 *  the page the agent last drove, else its current one. */
function handoffGuest(
  sessions: BrowserHostFoundation['sessions'],
  pageById: (sessionId: string, pageId: string) => WebContents | null,
  sessionId: string,
  tab: string
): WebContents | null {
  if (tab) return pageById(sessionId, tab);
  return sessions.agentPage(sessionId)?.guest ?? sessions.currentGuest(sessionId);
}

/** Answer one handoff fact; no value moves either way. `secret_bind` records
 *  the binding of `request_id` for an https page only: its page, main-frame
 *  document, origin, field form and the exact elements a fill writes;
 *  `login_accounts` lists an https sign-in page's masked saved logins only
 *  when the session's page is on that origin, binding that page and its
 *  main-frame document under `request_id` for the card's fill
 *  (fillBoundLogin). */
export async function handoffPageFacts(
  host: {
    guest(sessionId: string, tab: string): WebContents | null;
    pageId(guest: WebContents): string;
    /** The page's main-frame document now (credential-autofill.ts pageDocument). */
    document(guest: WebContents, signal?: AbortSignal): Promise<string>;
    inspect: Toolkit['credentialFill']['inspectSecretField'];
    accounts(url: string): Promise<Array<{ id: string; label: string }>>;
  },
  sessionId: string,
  action: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  registry: SecretInputs = secretInputs
): Promise<Record<string, unknown>> {
  const text = (key: string) => (typeof input[key] === 'string' ? String(input[key]).trim() : '');
  const guest = host.guest(sessionId, text('tab'));
  if (action === 'login_accounts') {
    const origin = httpsOrigin(text('url'));
    const onOrigin = (page: WebContents) => !page.isDestroyed() && httpsOrigin(page.getURL()) === origin;
    if (!origin || !guest || !onOrigin(guest)) return { accounts: [] };
    // The password (and username) elements the fill will write, bound now.
    const info = await host.inspect(guest, { form: 'login' }, signal);
    const { document, targets } = info;
    if (!document || !targets?.length || !onOrigin(guest)) return { accounts: [] };
    const accounts = await host.accounts(text('url'));
    // The page moved while its logins were read: nothing is bound or offered.
    if (!onOrigin(guest) || (await host.document(guest, signal)) !== document) return { accounts: [] };
    const binding = { sessionId, pageId: host.pageId(guest), document, origin, form: 'login' as const, targets };
    return {
      accounts: accounts.length && registry.bind(text('request_id'), binding, LOGIN_FILL_BINDING_MS) ? accounts : [],
    };
  }
  if (!guest || guest.isDestroyed()) return {};
  const url = guest.getURL();
  if (action === 'page_url') return { url };
  // Not an https page: no origin, and the runtime refuses the request
  // (ask-user-tool.mjs: blocked) before the user is asked for anything.
  const origin = httpsOrigin(url);
  if (!origin) return {};
  const info = await host.inspect(guest, { hint: text('field').slice(0, 80) }, signal);
  // No such field, or the page left the origin while it was read: nothing is bound.
  if (!info.form || !info.targets?.length || !info.document || httpsOrigin(guest.getURL()) !== origin) {
    return { origin, form: '' };
  }
  registry.bind(text('request_id'), {
    sessionId,
    pageId: host.pageId(guest),
    document: info.document,
    origin,
    form: info.form,
    targets: info.targets,
  });
  return { origin, form: info.form, ...(info.length ? { length: info.length } : {}) };
}

/** A turn's end: its temporary pages close, and the implicit blank page the
 *  agent has since left behind goes with them. */
export function finishBrowserTurn(
  host: {
    taskLifecycle: Pick<ReturnType<typeof createBrowserTaskLifecycle<WebContents>>, 'finish'>;
    sessions: Pick<BrowserHostFoundation['sessions'], 'agentPage'>;
    lifecycle: Pick<ReturnType<typeof createBrowserGuestLifecycle>, 'discardUntouchedBlank'>;
  },
  sessionId: string,
  turnId: number,
  options: { aborted: boolean }
): number {
  const closed = host.taskLifecycle.finish(sessionId, turnId, options);
  const page = host.sessions.agentPage(sessionId);
  if (page) host.lifecycle.discardUntouchedBlank(sessionId, page.guest);
  return closed;
}

function createBrowserActionServices(
  parts: Omit<BrowserActionServices, 'targets' | 'credentials' | 'runCommand'>,
  tools: { profileImporter: BrowserProfileImportService; credentialFill: Toolkit['credentialFill'] },
  runCommand: BrowserActionServices['runCommand']
): BrowserActionServices {
  const targets = createBrowserTargetResolver({
    captureSnapshotPayload: parts.snapshots.captureSnapshotPayload,
    state: parts.state,
    cdp: parts.cdp,
    evaluate: parts.cdp.evaluate,
  });
  return {
    ...parts,
    targets,
    credentials: {
      fillStored: storedCredentialFill(tools.profileImporter, (guest, credential, signal) =>
        tools.credentialFill.fillCredentialInGuest(guest, credential, signal)
      ),
    },
    runCommand,
  };
}

export function createBrowserHostAgent(options: {
  base: Pick<
    BrowserHostFoundation,
    | 'state'
    | 'cdp'
    | 'documents'
    | 'settle'
    | 'intercept'
    | 'urls'
    | 'partition'
    | 'profileImporter'
    | 'approvals'
    | 'sessions'
    | 'leave'
    | 'display'
    | 'commandChains'
    | 'pendingReads'
    | 'linkedSignIns'
  >;
  tools: Omit<Toolkit, 'dispatchInput'>;
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
  tabs: ReturnType<typeof createBrowserTabs>;
  taskLifecycle: ReturnType<typeof createBrowserTaskLifecycle<WebContents>>;
  retainGuest: (guest: WebContents) => void;
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
  /** The `browserAutoSignIn` setting (default on). */
  autoSignInEnabled?: () => boolean;
}) {
  const { base, tools, lifecycle, taskLifecycle } = options;
  const autoSignIn = createBrowserAutoSignIn(
    browserAutoSignInDeps(
      base,
      tools,
      options.autoSignInEnabled || (() => true),
      undefined,
      undefined,
      options.onDiagnostic
    )
  );
  const { state, cdp, sessions, leave, commandChains, pendingReads } = base;
  const services = createBrowserActionServices(
    {
      documents: base.documents,
      state,
      cdp,
      reply: tools.reply,
      settle: base.settle,
      input: tools.input,
      refActions: tools.refActions,
      refPoints: tools.refPoints,
      snapshots: tools.snapshots,
      screenshots: tools.screenshots,
      emulation: tools.emulation,
      pageState: tools.pageState,
      performance: tools.performance,
      intercept: base.intercept,
      initScripts: tools.initScripts,
      network: tools.network,
      dialogs: tools.dialogs,
      urls: base.urls,
      downloadsForSession: base.partition.downloadLedger.downloadsForSession,
    },
    { profileImporter: base.profileImporter, credentialFill: tools.credentialFill },
    (command, signal) => runCommand(command, signal)
  );
  // What the sign-in flows remember per turn goes with the turn or the session.
  sessions.onTurnFinished((sessionId, turn) => {
    autoSignIn.finishTurn(sessionId, turn);
    base.linkedSignIns.finishTurn(sessionId, turn);
  });
  sessions.onTurnForgotten((sessionId) => {
    autoSignIn.forgetSession(sessionId);
    base.linkedSignIns.forgetSession(sessionId);
  });
  const runCommand = createBrowserCommandRunner({
    state,
    approvals: base.approvals,
    browserSessions: sessions,
    lifecycle,
    tabs: options.tabs,
    downloads: tools.downloads,
    taskLifecycle,
    retainGuest: options.retainGuest,
    autoSignIn,
    linkedSignIn: {
      // An input's own attributes, read through the snapshot's ref (no eval).
      beforeAction: (guest, action, command, signal) =>
        base.linkedSignIns.beforeAction(
          guest,
          action,
          command,
          async (ref) => {
            const read = await services.snapshots.callAccessibilityRef<LinkedFieldFacts | null>(
              guest,
              ref,
              LINKED_FIELD_READ,
              [],
              signal,
              3_000
            );
            return read.handled ? read.value : null;
          },
          signal
        ),
      replyLine: base.linkedSignIns.replyLine,
    },
    // Every agent command reaches its page here, before acting on it: from
    // now on a veto answers the agent, not a person's earlier click or key.
    drivePage: (guest) => {
      leave.agentActs(guest);
      // A window the page opens from here on is the agent's (popup-focus).
      state.for(guest).actor = 'agent';
      const releaseDomains = cdp.drive(guest);
      const releasePower = base.display.power.drive(guest);
      return () => {
        releasePower();
        releaseDomains();
      };
    },
    services,
    onDiagnostic: options.onDiagnostic,
  });
  /** A page of the session by its page ID (shown or in the background). */
  const pageById = (sessionId: string, pageId: string): WebContents | null => {
    const wanted = pageId.toLowerCase();
    const guests = [
      ...sessions.visibleGuests(sessionId),
      ...[...sessions.backgroundPages(sessionId).values()].map((page) => page.guest),
    ];
    return guests.find((guest) => !guest.isDestroyed() && state.pageId(guest).toLowerCase() === wanted) ?? null;
  };
  const queue = createBrowserCommandQueue({
    chains: commandChains,
    pendingReads,
    sessionId: (command) => browserSessionId(command.session_id),
    currentPageId: (sessionId) => {
      const guest = sessions.currentGuest(sessionId);
      return guest && !guest.isDestroyed() ? state.pageId(guest) : undefined;
    },
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    run: runCommand,
    bounded: cdp.bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });
  const bridge = createBrowserAgentBridge({
    chains: commandChains,
    pendingReads,
    execute: (command, signal) => queue.executeSerialized(command, signal),
    finishTurn: (sessionId, turnId, finish) =>
      finishBrowserTurn({ taskLifecycle, sessions, lifecycle }, sessionId, turnId, finish),
    beginTurn: (sessionId, turnId) => sessions.beginTurn(sessionId, turnId),
    secretInput: (sessionId, requestId, signal) =>
      fillSecretInput({ pageById, fill: tools.credentialFill.fillSecretField }, sessionId, requestId, signal),
    handoffPage: (sessionId, action, input, signal) =>
      handoffPageFacts(
        {
          guest: (id, tab) => handoffGuest(sessions, pageById, id, tab),
          pageId: (guest) => state.pageId(guest),
          document: tools.credentialFill.pageDocument,
          inspect: tools.credentialFill.inspectSecretField,
          accounts: (url) => base.profileImporter.credentialSuggestions(url),
        },
        sessionId,
        action,
        input,
        signal
      ),
    visibleGuests: () => sessions.visibleGuests(),
    lifecycle,
    onDiagnostic: options.onDiagnostic,
  });
  /** The login card's saved-login fill into its takeover's bound page. */
  const loginFill = (sessionId: string, fillId: string, credentialId: string) =>
    fillBoundLogin(
      {
        pageById,
        useCredential: (url, id, use, signal) => base.profileImporter.useCredential(url, id, use, signal),
        fill: tools.credentialFill.fillSecretField,
        inspect: tools.credentialFill.inspectSecretField,
      },
      browserSessionId(sessionId),
      fillId,
      credentialId
    );
  return { ...queue, bridge, loginFill };
}
