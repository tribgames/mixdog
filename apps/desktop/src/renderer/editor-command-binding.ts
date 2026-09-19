import type { editor, IDisposable } from 'monaco-editor';

interface CommandSlot {
  handler: (() => void) | null;
}

const bindings = new WeakMap<editor.IStandaloneCodeEditor, Map<number, CommandSlot>>();

/** Monaco commands live as long as a shared surface; tab callbacks do not. */
export function bindEditorCommand(
  editor: editor.IStandaloneCodeEditor,
  keybinding: number,
  handler: () => void
): IDisposable {
  let commands = bindings.get(editor);
  if (!commands) {
    commands = new Map();
    bindings.set(editor, commands);
  }
  let slot = commands.get(keybinding);
  if (!slot) {
    const created: CommandSlot = { handler: null };
    commands.set(keybinding, created);
    editor.addCommand(keybinding, () => created.handler?.());
    slot = created;
  }
  const owned = slot;
  owned.handler = handler;
  return {
    dispose() {
      if (owned.handler === handler) owned.handler = null;
    },
  };
}
