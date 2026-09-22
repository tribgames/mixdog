// core-memory-picker/entry-prompts.mjs
// The three text-entry prompts of the Memory flow. Each closes the panel with
// its own claim first — the keypress that opens the prompt owns the surface it
// clears — and then hands App a settings-prompt descriptor.
export function createCoreMemoryPrompts({ surface, setSettingsPrompt }) {
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
      _indexRevision: entryItem._indexRevision,
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
      _indexRevision: entryItem._indexRevision,
      _projectId: entryItem._projectId ?? null,
    });
  };

  return { beginAddCoreMemory, beginEditCoreMemory, beginDeleteCoreMemory };
}
