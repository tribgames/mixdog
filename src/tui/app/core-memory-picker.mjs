/**
 * core-memory-picker.mjs — the Core Memory picker + add/edit/delete flow.
 *
 * A dependency-injection factory: these openers drive the panel surface +
 * setSettingsPrompt and read live store state, so they can't be pure.
 * The Esc-return target is per-entry: the Settings row passes { returnTo },
 * the standalone /memory command passes { returnTo: null }, and Esc either
 * reopens the caller or simply closes the picker.
 *
 * This file owns the root panel and that Esc-return target; the panels below it
 * live in core-memory-picker/ — the stored-memory list and per-entry actions
 * (list-panels), the three text-entry prompts (entry-prompts) and the shared
 * read + row shapes (core-rows).
 */
import { loadCoreRows, entrySummaryFooter, rootRows } from './core-memory-picker/core-rows.mjs';
import { createCoreMemoryPrompts } from './core-memory-picker/entry-prompts.mjs';
import { createCoreMemoryListPanels } from './core-memory-picker/list-panels.mjs';

export function createCoreMemoryPicker({ store, surface, setSettingsPrompt, parseMemoryCoreRows }) {
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
  const { beginAddCoreMemory, beginEditCoreMemory, beginDeleteCoreMemory } = createCoreMemoryPrompts({
    surface,
    setSettingsPrompt,
  });
  const { openCoreMemoryListPicker, openCoreEntryActionsPicker } = createCoreMemoryListPanels({
    store,
    surface,
    parseMemoryCoreRows,
    reopenRoot: () => openMemoryCorePicker(),
    beginEditCoreMemory,
    beginDeleteCoreMemory,
  });

  const openMemoryCorePicker = (options = {}) => {
    if (options && Object.hasOwn(options, 'returnTo')) {
      escReturnTo = typeof options.returnTo === 'function' ? options.returnTo : null;
    }
    // Surface claim (panel-surface.mjs): every paint re-validates and re-arms
    // it, so the loading frame can take the surface while a list (or failure
    // close) landing after Esc cannot touch it.
    const own = surface.claim();
    own.paint({
      title: 'Memory',
      // Loading state lives in the header description row, not as a fake
      // selectable menu item.
      description: 'Loading memories…',
      loading: true,
      items: [],
      onSelect: () => {},
      onCancel: closeMemoryCorePicker,
    });
    void loadCoreRows({ store, parseMemoryCoreRows })
      ?.then((coreRows) => {
        own.paint({
          title: 'Memory',
          description: 'User-curated core memories across projects.',
          items: rootRows(coreRows),
          // Summary-first layout: entry rows carry the sentence in
          // `description`, so keep the label column minimal and show the
          // full untruncated sentence for the highlighted row in the footer.
          labelWidth: 12,
          footer: entrySummaryFooter,
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

  return {
    openMemoryCorePicker,
    openCoreEntryActionsPicker,
    beginAddCoreMemory,
    beginEditCoreMemory,
    beginDeleteCoreMemory,
  };
}
