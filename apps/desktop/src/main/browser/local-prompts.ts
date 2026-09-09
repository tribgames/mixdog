import type { WebContents } from 'electron';
import type { DesktopBrowserPageControl, DesktopBrowserPageFrame } from '../../shared/contract';
import type { BrowserGuestStateStore } from './guest-state';
import type { createBrowserDialogReport } from './dialog-report';
import type { createBrowserRefActions } from './ref-actions';

type PromptControl = Extract<DesktopBrowserPageControl, { type: 'answer-dialog' | 'choose-files' }>;

/** Human answers are bound to a specific prompt as well as a document.
 * Only the trusted main process chooses file paths; the renderer sends none. */
export function createBrowserLocalPrompts(host: {
  state: BrowserGuestStateStore;
  dialogs: Pick<ReturnType<typeof createBrowserDialogReport>, 'handleDialog'>;
  uploads: Pick<ReturnType<typeof createBrowserRefActions>, 'uploadRef'>;
  chooseFiles(multiple: boolean): Promise<{ canceled: boolean; filePaths: string[] }>;
}) {
  const ids = new WeakMap<object, string>();
  const picking = new WeakSet<object>();
  let serial = 0;
  const id = (pending: object) => {
    let value = ids.get(pending);
    if (!value) { value = `prompt_${++serial}`; ids.set(pending, value); }
    return value;
  };
  return {
    describe(guest: WebContents): Pick<DesktopBrowserPageFrame, 'dialog' | 'fileChooser'> {
      const { pendingDialog: dialog, pendingFileChooser: chooser } = host.state.for(guest);
      return {
        ...(dialog ? { dialog: { id: id(dialog), type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt } } : {}),
        ...(chooser ? { fileChooser: { id: id(chooser), multiple: chooser.mode === 'selectMultiple' } } : {}),
      };
    },
    async answer(guest: WebContents, input: PromptControl, assertCurrent: () => void, signal?: AbortSignal) {
      const record = host.state.for(guest);
      const pending = input.type === 'answer-dialog' ? record.pendingDialog : record.pendingFileChooser;
      const guard = () => {
        signal?.throwIfAborted();
        assertCurrent();
        const current = input.type === 'answer-dialog' ? record.pendingDialog : record.pendingFileChooser;
        if (!pending || current !== pending || id(pending) !== input.requestId) {
          throw new Error('Browser prompt changed; answer was not sent.');
        }
      };
      guard();
      if (input.type === 'answer-dialog') {
        await host.dialogs.handleDialog(guest, input.accept, input.promptText ?? '', signal, guard);
        return;
      }
      if (picking.has(pending!)) throw new Error('Browser file selection is already open.');
      picking.add(pending!);
      try {
        const result = input.cancel ? { canceled: true, filePaths: [] }
          : await host.chooseFiles(record.pendingFileChooser!.mode === 'selectMultiple');
        guard();
        if (result.canceled) {
          record.pendingFileChooser = null;
          return;
        }
        await host.uploads.uploadRef(guest, undefined, result.filePaths, signal, guard);
      } finally { picking.delete(pending!); }
    },
  };
}
