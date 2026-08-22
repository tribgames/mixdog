/**
 * resume-picker.mjs — the /resume saved-chat session picker.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory: openResumePicker drives the panel surface and reads live store
 * state, so it can't be pure. The function body is the original App logic
 * verbatim, with closure identifiers (store, surface, and the two session
 * formatters from projects.mjs) threaded in through the factory argument.
 */
export function createResumePicker({
  store,
  surface,
  formatSessionUpdatedAt,
  formatSessionMessageCount,
}) {
  const openResumePicker = async () => {
    // Surface claim (panel-surface.mjs): the storage rescan below is slow, so
    // Esc can easily land before this panel ever paints.
    const own = surface.claim();
    let sessions;
    try {
      // Terminal ↔ desktop interop: the summary cache is per-process, so a
      // session created/updated by the desktop app (or another CLI) after this
      // process's first listing would be invisible without an authoritative
      // storage rescan on picker open.
      sessions = await store.listSessions({ refreshFromStorage: true });
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
      const title = String(s.title || '').replace(/\s+/g, ' ').trim();
      const count = formatSessionMessageCount(s.messageCount);
      return {
        value: s.id,
        label: `${formatSessionUpdatedAt(s.updatedAt)}  ${count}`,
        description: title || preview || '(no message)',
      };
    });
    own.paint({
      title: 'Resume',
      description: 'Restore a saved chat session.',
      items,
      labelWidth: 21,
      onSelect: (value) => {
        own.close();
        const selected = sessions.find((session) => session.id === value);
        const resumedName = String(selected?.title || selected?.preview || value)
          .replace(/\s+/g, ' ')
          .trim();
        void store.resume(value)
          .then(ok => store.pushNotice(ok ? `Resumed ${resumedName || value}` : 'Couldn’t resume chat.', ok ? 'info' : 'warn'))
          .catch((e) => store.pushNotice(`Couldn’t resume chat: ${e?.message || e}`, 'error'));
      },
      onCancel: () => {
        own.close();
      },
    });
  };

  return { openResumePicker };
}
