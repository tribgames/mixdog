// core-memory-picker/list-panels.mjs
// The two panels below the Memory root: the stored-memory list (served from
// rows the root already fetched, or from its own read) and the per-entry
// actions. Esc on the list goes back to the root through `reopenRoot`, which
// the owning factory supplies so the root stays the single opener of that
// surface.
import { entrySummaryFooter, loadCoreRows } from './core-rows.mjs';

export function createCoreMemoryListPanels({
  store,
  surface,
  parseMemoryCoreRows,
  reopenRoot,
  beginEditCoreMemory,
  beginDeleteCoreMemory,
}) {
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

  const openCoreMemoryListPicker = (rows = null) => {
    // Same ownership rule as openMemoryCorePicker.
    const own = surface.claim();
    const renderList = (coreRows) => {
      own.paint({
        title: 'Memory · List',
        description: coreRows.length ? 'Select a memory to edit or delete.' : 'No stored memories yet.',
        items: coreRows.length ? coreRows : [{ value: 'empty', label: 'Memory', description: 'empty' }],
        labelWidth: 12,
        footer: entrySummaryFooter,
        onSelect: (_value, item) => {
          if (item?._action === 'core-entry') openCoreEntryActionsPicker(item);
          else if (item?._line) store.pushNotice(item._line, 'info');
        },
        onCancel: reopenRoot,
      });
    };

    if (Array.isArray(rows)) {
      renderList(rows);
      return;
    }

    own.paint({
      title: 'Memory · List',
      description: 'Loading memories…',
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: reopenRoot,
    });
    void loadCoreRows({ store, parseMemoryCoreRows })
      ?.then(renderList)
      .catch((e) => {
        own.close();
        store.pushNotice(`core memory failed: ${e?.message || e}`, 'error');
      });
  };

  return { openCoreMemoryListPicker, openCoreEntryActionsPicker };
}
