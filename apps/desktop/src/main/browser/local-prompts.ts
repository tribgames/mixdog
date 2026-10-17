import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl, DesktopBrowserPageFrame } from '../../shared/contract';
import type { BrowserGuestStateStore } from './guest-state';
import type { createBrowserDialogReport } from './dialog-report';
import type { createBrowserRefActions } from './ref-actions';
import type { BrowserLeaveConfirmation } from './leave-confirmation';
import type { BrowserPermissions } from './permissions';

type PromptControl = Extract<DesktopBrowserPageControl, { type: 'answer-dialog' | 'choose-files' }>;

type PaneDialog = NonNullable<DesktopBrowserPageFrame['dialog']>;

const PROMPT_CHANGED = 'Browser prompt changed; answer was not sent.';

/** Human answers are bound to a specific prompt as well as a document.
 * Only the trusted main process chooses file paths; the renderer sends none.
 *
 * The dialog a view of a page offers is, in order: the dialog holding the
 * page (its own, or one open on a page sharing its renderer), a leave
 * confirmation, then a notice of a dialog the page opened that was dismissed
 * unseen. A dialog on a page another session controls blocks this one too,
 * but what it says and how it is answered stay with that session: the view
 * only says it is waiting. */
export function createBrowserLocalPrompts(host: {
  state: BrowserGuestStateStore;
  dialogs: Pick<ReturnType<typeof createBrowserDialogReport>, 'handleDialog'>;
  uploads: Pick<ReturnType<typeof createBrowserRefActions>, 'uploadRef'>;
  chooseFiles(multiple: boolean): Promise<{ canceled: boolean; filePaths: string[] }>;
  /** The session controlling a page, if any: the one whose views show it. */
  controller(guest: WebContents): string | undefined;
  /** A person's leave request the page vetoed, asked as a beforeunload dialog. */
  leave?: Pick<BrowserLeaveConfirmation, 'pending' | 'answer'>;
  /** Site permission requests, asked as a `permission` dialog only a person
   *  answers; the agent's handle_dialog never reaches them. */
  permissions?: Pick<BrowserPermissions, 'pending' | 'answer'>;
}) {
  const ids = new WeakMap<object, string>();
  const picking = new WeakSet<object>();
  const acknowledged = new WeakSet<object>();
  let serial = 0;
  const id = (pending: object) => {
    let value = ids.get(pending);
    if (!value) {
      value = `prompt_${++serial}`;
      ids.set(pending, value);
    }
    return value;
  };
  /** Throws unless `pending` is still the prompt answered, in the document shown. */
  const guardFor =
    (
      current: () => object | null,
      pending: object | null,
      requestId: string,
      assertCurrent: () => void,
      signal?: AbortSignal
    ) =>
    () => {
      signal?.throwIfAborted();
      assertCurrent();
      if (!pending || current() !== pending || id(pending) !== requestId) throw new Error(PROMPT_CHANGED);
    };

  /** Whether the session viewing `guest` controls `owner`, whose dialog holds it. */
  const controls = (guest: WebContents, owner: WebContents) => {
    const session = host.controller(guest);
    return owner === guest || (session !== undefined && host.controller(owner) === session);
  };

  function dialogFor(guest: WebContents): PaneDialog | undefined {
    const blocking = host.state.blockingDialog(guest);
    if (blocking) {
      const { owner, dialog } = blocking;
      if (!controls(guest, owner)) return { id: id(dialog), type: 'blocked', message: '' };
      return { id: id(dialog), type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt };
    }
    const leave = host.leave?.pending(guest);
    if (leave) return { id: leave, type: 'beforeunload', message: '' };
    const permission = host.permissions?.pending(guest);
    if (permission) {
      const { id: permissionId, ...asking } = permission;
      return { id: permissionId, type: 'permission', message: '', permission: asking };
    }
    const dismissed = host.state.for(guest).dismissedDialog;
    if (dismissed && !acknowledged.has(dismissed)) return { id: id(dismissed), type: 'dismissed', message: '' };
    return undefined;
  }

  /** Answer what dialogFor offers on `guest`. */
  async function answerDialog(
    guest: WebContents,
    input: Extract<PromptControl, { type: 'answer-dialog' }>,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    const blocking = host.state.blockingDialog(guest);
    if (blocking) {
      const { owner, dialog } = blocking;
      if (!controls(guest, owner)) {
        throw new Error("Browser dialog belongs to another session's page; answer was not sent.");
      }
      const guard = guardFor(() => host.state.for(owner).pendingDialog, dialog, input.requestId, assertCurrent, signal);
      guard();
      await host.dialogs.handleDialog(
        owner,
        input.accept,
        input.promptText ?? '',
        signal,
        guard,
        input.keepDefault === true
      );
      host.state.invalidateInteraction(owner);
      return;
    }
    assertCurrent();
    const leave = host.leave;
    const dismissed = host.state.for(guest).dismissedDialog;
    const permissions = host.permissions;
    if (leave?.pending(guest)) {
      if (!leave.answer(guest, input.requestId, input.accept)) throw new Error(PROMPT_CHANGED);
    } else if (permissions?.pending(guest)) {
      if (!permissions.answer(guest, input.requestId, input.accept)) throw new Error(PROMPT_CHANGED);
    } else if (dismissed && id(dismissed) === input.requestId) {
      acknowledged.add(dismissed);
    } else throw new Error(PROMPT_CHANGED);
  }

  return {
    describe(guest: WebContents): Pick<DesktopBrowserPageFrame, 'dialog' | 'fileChooser'> {
      const dialog = dialogFor(guest);
      const chooser = host.state.for(guest).pendingFileChooser;
      return {
        ...(dialog ? { dialog } : {}),
        ...(chooser ? { fileChooser: { id: id(chooser), multiple: chooser.mode === 'selectMultiple' } } : {}),
      };
    },
    async answer(guest: WebContents, input: PromptControl, assertCurrent: () => void, signal?: AbortSignal) {
      if (input.type === 'answer-dialog') return answerDialog(guest, input, assertCurrent, signal);
      const record = host.state.for(guest);
      const chooser = record.pendingFileChooser;
      const guard = guardFor(() => record.pendingFileChooser, chooser, input.requestId, assertCurrent, signal);
      guard();
      if (picking.has(chooser!)) throw new Error('Browser file selection is already open.');
      picking.add(chooser!);
      try {
        const result = input.cancel
          ? { canceled: true, filePaths: [] }
          : await host.chooseFiles(chooser!.mode === 'selectMultiple');
        guard();
        if (result.canceled) record.pendingFileChooser = null;
        else await host.uploads.uploadRef(guest, undefined, result.filePaths, signal, guard);
      } finally {
        picking.delete(chooser!);
      }
    },
  };
}
