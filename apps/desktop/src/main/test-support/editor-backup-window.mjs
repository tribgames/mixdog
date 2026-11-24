import { EventEmitter } from 'node:events';

import { DESKTOP_IPC } from '../../shared/contract-ipc.ts';
import { joinEditorBackupFlush } from '../editor-backup-flush.ts';

/** A window joined to the editor-backup flush. `load()` finishes its page, `asked` settles when the flush request reaches
 *  it (`events` hears `flush:<name>`), `answer()` is its renderer's reply to that request, `leave()` unjoins it. */
export function backupWindow(name = 'window', events = []) {
  let request = null;
  let reached = () => {};
  const asked = new Promise((resolve) => (reached = resolve));
  const contents = Object.assign(new EventEmitter(), {
    ipc: new EventEmitter(),
    isDestroyed: () => false,
    send: (channel, id) => {
      if (channel !== DESKTOP_IPC.flushEditorBackups) return;
      events.push(`flush:${name}`);
      request = id;
      reached();
    },
  });
  const leave = joinEditorBackupFlush({ isDestroyed: () => false, webContents: contents });
  return {
    contents,
    asked,
    leave,
    load: () => contents.emit('did-finish-load'),
    answer: () => contents.ipc.emit(DESKTOP_IPC.editorBackupsFlushed, {}, request),
  };
}
