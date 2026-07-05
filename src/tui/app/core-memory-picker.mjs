/**
 * core-memory-picker.mjs — the Core Memory picker + add/edit/delete flow.
 *
 * Extracted from App.jsx behavior-preservingly as a dependency-injection
 * factory: these openers drive setPicker + setSettingsPrompt and read live
 * store state, so they can't be pure. Every function body is the original App
 * logic verbatim, with closure identifiers threaded through the factory
 * argument. The Esc-return target is per-entry: the Settings row passes
 * { returnTo }, the standalone /memory command passes { returnTo: null },
 * and Esc either reopens the caller or simply closes the picker.
 */
export function createCoreMemoryPicker({
  store,
  setPicker,
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
    else setPicker(null);
  };
  const openMemoryCorePicker = (options = {}) => {
    if (options && Object.prototype.hasOwnProperty.call(options, 'returnTo')) {
      escReturnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    }
    setPicker({
      title: 'Memory',
      // Loading state lives in the header description row, not as a fake
      // selectable menu item.
      description: 'Loading memories…',
      items: [],
      onSelect: () => {},
      onCancel: closeMemoryCorePicker,
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => {
        // Memory on/off lives here too so /memory is a one-stop surface:
        // toggle row + add row + curated entries.
        const memory = store.getMemorySettings?.() || { enabled: true };
        const memoryOn = memory.enabled !== false;
        const coreRows = parseMemoryCoreRows(result);
        const rows = [
          {
            value: 'memory-toggle',
            label: 'Memory',
            meta: memoryOn ? 'On' : 'Off',
            description: memoryOn
              ? 'Background memory cycles on'
              : 'Background memory cycles off',
            _action: 'toggle-memory',
          },
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
        setPicker({
          title: 'Memory',
          description: 'User-curated core memories across projects.',
          items: rows.length ? rows : [{ value: 'empty', label: 'Memory', description: 'empty' }],
          // Summary-first layout: entry rows carry the sentence in
          // `description`, so keep the label column minimal and show the
          // full untruncated sentence for the highlighted row in the footer.
          labelWidth: 12,
          footer: (item) => (item && item._action === 'core-entry' ? (item._summary || item._element || '') : ''),
          onSelect: (_value, item) => {
            if (item?._action === 'toggle-memory') toggleMemoryEnabled();
            else if (item?._action === 'add-core') beginAddCoreMemory();
            else if (item?._action === 'core-list') openCoreMemoryListPicker(item._rows);
            else if (item?._line) store.pushNotice(item._line, 'info');
          },
          // Toggle rows also respond to ←/→ (matches settings/channels UX).
          onLeft: (item) => {
            if (item?._action === 'toggle-memory') toggleMemoryEnabled();
          },
          onRight: (item) => {
            if (item?._action === 'toggle-memory') toggleMemoryEnabled();
          },
          onCancel: closeMemoryCorePicker,
        });
      })
      .catch((e) => {
        setPicker(null);
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  const openCoreMemoryListPicker = (rows = null) => {
    const renderList = (coreRows) => {
      setPicker({
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

    setPicker({
      title: 'Memory · List',
      description: 'Loading memories…',
      items: [],
      onSelect: () => {},
      onCancel: () => openMemoryCorePicker(),
    });
    void store.memoryControl?.({ action: 'core', op: 'list', project_id: '*' }, { silent: true })
      .then((result) => renderList(parseMemoryCoreRows(result)))
      .catch((e) => {
        setPicker(null);
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  const toggleMemoryEnabled = () => {
    const memory = store.getMemorySettings?.() || { enabled: true };
    void Promise.resolve(store.setMemoryEnabled?.(!(memory.enabled !== false)))
      .then((next) => {
        if (!next) store.pushNotice('memory setting is busy', 'warn');
        else store.pushNotice(`Memory ${next.enabled ? 'on' : 'off'}`, 'info');
      })
      .catch((e) => store.pushNotice(`memory toggle failed: ${e?.message || e}`, 'error'))
      .finally(() => openMemoryCorePicker());
  };

  const openCoreEntryActionsPicker = (entryItem) => {
    setPicker({
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
    setPicker(null);
    setSettingsPrompt({
      kind: 'core-add',
      label: 'Add memory',
      hint: 'Type the memory sentence to store as a core memory.',
    });
  };

  const beginEditCoreMemory = (entryItem) => {
    setPicker(null);
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
    setPicker(null);
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
