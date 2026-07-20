/**
 * resume-picker.mjs — the /resume saved-chat session picker.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory: openResumePicker drives setPicker and reads live store state, so it
 * can't be pure. The function body is the original App logic verbatim, with
 * closure identifiers (store, setPicker, and the two session formatters from
 * projects.mjs) threaded in through the factory argument.
 */
export function createResumePicker({
  store,
  setPicker,
  formatSessionUpdatedAt,
  formatSessionMessageCount,
}) {
  const openResumePicker = () => {
    let sessions;
    try {
      // Terminal ↔ desktop interop: the summary cache is per-process, so a
      // session created/updated by the desktop app (or another CLI) after this
      // process's first listing would be invisible without an authoritative
      // storage rescan on picker open.
      sessions = store.listSessions({ refreshFromStorage: true });
    } catch (e) {
      store.pushNotice(`could not list saved chats: ${e?.message || e}`, 'error');
      return;
    }
    if (!sessions || sessions.length === 0) {
      store.pushNotice('no saved chats', 'warn');
      return;
    }
    const items = sessions.map((s) => {
      const preview = String(s.preview || '').replace(/\n/g, ' ').trim();
      const count = formatSessionMessageCount(s.messageCount);
      return {
        value: s.id,
        label: `${formatSessionUpdatedAt(s.updatedAt)}  ${count}`,
        description: preview || '(no message)',
      };
    });
    setPicker({
      title: 'Resume',
      description: 'Restore a saved chat session.',
      items,
      labelWidth: 21,
      onSelect: (value) => {
        setPicker(null);
        void store.resume(value)
          .then(ok => store.pushNotice(ok ? `Resumed ${value}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        setPicker(null);
      },
    });
  };

  return { openResumePicker };
}
