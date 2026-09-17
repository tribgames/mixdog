import type { editor } from 'monaco-editor';

export interface EditorSurface {
  editor: editor.IStandaloneCodeEditor;
  element: HTMLElement;
}

interface SurfaceEntry {
  surface: EditorSurface;
  owner: object | null;
  detach: (() => void) | null;
}

/** One visual editor per pane. Documents and their undo stacks belong to tabs. */
export class EditorSurfacePool {
  private readonly entries = new Map<string, SurfaceEntry>();

  acquire(key: string, owner: object, create: () => EditorSurface, detach: () => void): EditorSurface {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { surface: create(), owner: null, detach: null };
      this.entries.set(key, entry);
    }
    if (entry.owner !== null && entry.owner !== owner) entry.detach?.();
    entry.owner = owner;
    entry.detach = detach;
    return entry.surface;
  }

  release(key: string, owner: object): void {
    const entry = this.entries.get(key);
    if (!entry || entry.owner !== owner) return;
    entry.detach?.();
    entry.owner = null;
    entry.detach = null;
    // A tab switch transfers the surface in this commit. Leaving the editor
    // entirely releases it, without retaining a hidden Monaco DOM tree.
    queueMicrotask(() => {
      if (entry.owner !== null || this.entries.get(key) !== entry) return;
      this.entries.delete(key);
      entry.surface.editor.dispose();
      entry.surface.element.remove();
    });
  }
}
