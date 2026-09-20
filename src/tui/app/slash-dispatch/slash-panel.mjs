// slash-dispatch/slash-panel.mjs
// The loading frame a bare slash command paints while its picker opens, and
// its release when the opener finished without painting anything.
export function createSlashPanelOpener({ surface, store }) {
  return (command, title, open) => {
    const own = surface.claim();
    if (
      !own.paint({
        _kind: `slash-loading:${command}`,
        title,
        description: `Loading ${title.toLowerCase()}...`,
        help: 'Esc Close',
        indexMode: 'never',
        pickerKey: `slash-loading:${command}`,
        loading: true,
        items: [],
        onSelect: () => {},
        onCancel: () => own.close(),
      })
    )
      return;
    const finishUnclaimedLoading = () => {
      // A real picker/context/usage surface supersedes this loading identity.
      // If the opener completed without painting (empty result or failure),
      // remove only the still-owned placeholder and restore the normal prompt.
      if (own.owns()) own.close();
    };
    try {
      const opening = open();
      if (opening && typeof opening.then === 'function') {
        void Promise.resolve(opening).then(finishUnclaimedLoading, (error) => {
          finishUnclaimedLoading();
          store.pushNotice(`${title} panel failed: ${error?.message || error}`, 'error');
        });
      } else {
        finishUnclaimedLoading();
      }
    } catch (error) {
      finishUnclaimedLoading();
      store.pushNotice(`${title} panel failed: ${error?.message || error}`, 'error');
    }
  };
}
