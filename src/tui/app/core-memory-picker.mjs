/**
 * core-memory-picker.mjs — the Core Memory picker + add/edit/delete flow.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory: these openers drive the panel surface + setSettingsPrompt and read
 * live store state, so they can't be pure. Every function body is the original
 * App logic verbatim, with closure identifiers threaded through the factory
 * argument. The Esc-return target is per-entry: the Settings row passes
 * { returnTo }, the standalone /memory command passes { returnTo: null },
 * and Esc either reopens the caller or simply closes the picker.
 */
export function createCoreMemoryPicker({
  store,
  surface,
  setSettingsPrompt,
  parseMemoryCoreRows,
}) {
  // Sticky Esc-return target. Settings entry passes { returnTo: openSettingsPicker };
  // standalone entry (/memory) passes { returnTo: null } so Esc just closes.
  // Nested reopens (entry actions, post add/edit/delete) pass no `returnTo`
  // key and inherit the entry context.
  let escReturnTo = null;
  const closeMemoryCorePicker = () => {
    if (escReturnTo) escReturnTo();
    // Esc on the panel: this keypress owns the surface it clears.
    else surface.claim().close();
  };
  const openMemoryCorePicker = (options = {}) => {
    if (options && Object.prototype.hasOwnProperty.call(options, 'returnTo')) {
      escReturnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    }
    // Surface claim (panel-surface.mjs): every paint re-validates and re-arms
    // it, so the loading frame can take the surface while a list (or failure
    // close) landing after Esc cannot touch it.
    const own = surface.claim();
    const paintPanel = (panel) => own.paint(panel);
    paintPanel({
      title: 'Memory',
      // Loading state lives in the header description row, not as a fake
      // selectable menu item.
      description: 'Loading memories…',
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: closeMemoryCorePicker,
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => {
        const coreRows = parseMemoryCoreRows(result);
        const rows = [
          { value: 'core-add', label: 'Add Memory', description: 'store a new curated memory sentence', _action: 'add-core' },
          {
            value: 'core-list',
            label: 'Memory List',
            meta: coreRows.length ? String(coreRows.length) : '',
            description: coreRows.length
              ? 'open stored memories for edit/delete'
              : 'no stored memories',
            _action: 'core-list',
            _rows: coreRows,
          },
        ];
        paintPanel({
          title: 'Memory',
          description: 'User-curated core memories across projects.',
          items: rows.length ? rows : [{ value: 'empty', label: 'Memory', description: 'empty' }],
          // Summary-first layout: entry rows carry the sentence in
          // `description`, so keep the label column minimal and show the
          // full untruncated sentence for the highlighted row in the footer.
          labelWidth: 12,
          footer: (item) => (item && item._action === 'core-entry' ? (item._summary || item._element || '') : ''),
          onSelect: (_value, item) => {
            if (item?._action === 'add-core') beginAddCoreMemory();
            else if (item?._action === 'core-list') openCoreMemoryListPicker(item._rows);
            else if (item?._line) store.pushNotice(item._line, 'info');
          },
          onCancel: closeMemoryCorePicker,
        });
      })
      .catch((e) => {
        own.close();
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  const openCoreMemoryListPicker = (rows = null) => {
    // Same ownership rule as openMemoryCorePicker.
    const own = surface.claim();
    const paintPanel = (panel) => own.paint(panel);
    const renderList = (coreRows) => {
      paintPanel({
        title: 'Memory · List',
        description: coreRows.length
          ? 'Select a memory to edit or delete.'
          : 'No stored memories yet.',
        items: coreRows.length
          ? coreRows
          : [{ value: 'empty', label: 'Memory', description: 'empty' }],
        labelWidth: 12,
        footer: (item) => (item && item._action === 'core-entry' ? (item._summary || item._element || '') : ''),
        onSelect: (_value, item) => {
          if (item?._action === 'core-entry') openCoreEntryActionsPicker(item);
          else if (item?._line) store.pushNotice(item._line, 'info');
        },
        onCancel: () => openMemoryCorePicker(),
      });
    };

    if (Array.isArray(rows)) {
      renderList(rows);
      return;
    }

    paintPanel({
      title: 'Memory · List',
      description: 'Loading memories…',
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: () => openMemoryCorePicker(),
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => {
        renderList(parseMemoryCoreRows(result));
      })
      .catch((e) => {
        own.close();
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  const openCoreEntryActionsPicker = (entryItem) => {
    // Synchronous panel for an Enter on a list row: an ordinary claimed paint.
    const own = surface.claim();
    own.paint({
      title: `Memory · #${entryItem._id}`,
      description: entryItem._summary || entryItem._element || '',
      items: [
        { value: 'delete', label: 'Delete', description: 'remove this entry (confirm)', _action: 'delete' },
        { value: 'edit', label: 'Edit', description: 'rewrite this memory sentence', _action: 'edit' },
      ],
      onSelect: (_value, detail) => {
        if (detail._action === 'edit') beginEditCoreMemory(entryItem);
        else if (detail._action === 'delete') beginDeleteCoreMemory(entryItem);
      },
      onCancel: () => openCoreMemoryListPicker(),
    });
  };

  const beginAddCoreMemory = () => {
    surface.claim().close();
    setSettingsPrompt({
      kind: 'core-add',
      label: 'Add memory',
      hint: 'Type the memory sentence to store as a core memory.',
    });
  };

  const beginEditCoreMemory = (entryItem) => {
    surface.claim().close();
    setSettingsPrompt({
      kind: 'core-edit',
      label: `Memory · Edit #${entryItem._id}`,
      hint: 'Edit the memory sentence.',
      initialValue: entryItem._summary || entryItem._element || '',
      _id: entryItem._id,
      _projectId: entryItem._projectId ?? null,
      // Only rewrite `element` on edit when the row was already a
      // single-sentence entry (element === summary at load time). Otherwise
      // element carries distinct legacy meaning and must survive untouched.
      _singleSentence: entryItem._origElement === entryItem._origSummary,
    });
  };

  const beginDeleteCoreMemory = (entryItem) => {
    surface.claim().close();
    setSettingsPrompt({
      kind: 'core-delete-confirm',
      label: `Memory · Delete #${entryItem._id}?`,
      hint: 'Type "y" to delete this entry, or anything else to cancel.',
      _id: entryItem._id,
      _projectId: entryItem._projectId ?? null,
    });
  };

  return {
    openMemoryCorePicker,
    openCoreEntryActionsPicker,
    beginAddCoreMemory,
    beginEditCoreMemory,
    beginDeleteCoreMemory,
  };
}
