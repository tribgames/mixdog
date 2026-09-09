/** Successful reads stay available while a panel refresh runs in the background. */
export class ProjectEditorCache<T> {
  private entries = new Map<string | null, { value?: T; pending?: Promise<T> }>();

  peek(path: string | null): T | undefined {
    return this.entries.get(path)?.value;
  }

  read(path: string | null, load: () => Promise<T>, refresh = false): Promise<T> {
    let entry = this.entries.get(path);
    if (!entry) {
      entry = {};
      this.entries.set(path, entry);
    }
    if (!refresh && entry.value !== undefined) return Promise.resolve(entry.value);
    if (entry.pending) return entry.pending;
    const target = entry;
    const pending = Promise.resolve().then(load).then((value) => {
      if (target.pending === pending) target.value = value;
      return value;
    }).finally(() => {
      if (target.pending === pending) target.pending = undefined;
    });
    target.pending = pending;
    return pending;
  }

  set(path: string | null, value: T): void {
    // Replace the entry so an older read cannot overwrite a successful save.
    this.entries.set(path, { value });
  }

  invalidate(path: string | null): void {
    this.entries.delete(path);
  }
}

export type CoreMemoryEntry = {
  id: number;
  element: string;
  summary: string;
  singleSentence: boolean;
  indexRevision?: string;
};

export function parseCoreMemoryEntries(value: unknown): CoreMemoryEntry[] {
  let structured: unknown = value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    structured = JSON.parse(value);
  }
  if (structured && typeof structured === 'object' && 'entries' in structured) {
    const rows = (structured as { entries: Array<{ id: number | null; element?: string; summary?: string; source?: string; index_revision?: string }> }).entries;
    return rows.filter(row => row.source !== 'generated' && row.id !== null).map(row => ({
      id: row.id!, element: row.element || '', summary: row.summary || row.element || '',
      singleSentence: !row.element || row.element === row.summary,
      indexRevision: row.index_revision,
    })).sort((a, b) => a.id - b.id);
  }
  const entries: CoreMemoryEntry[] = [];
  for (const line of String(value || '').split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^id=(\d+)\s+(.+?)(?:\s+—\s+(.+))?$/);
    if (!match) continue;
    const element = match[2];
    const rawSummary = match[3] || '';
    entries.push({
      id: Number(match[1]),
      element,
      summary: rawSummary || element,
      singleSentence: !rawSummary || element === rawSummary,
    });
  }
  return entries.sort((left, right) => right.id - left.id);
}

export function memoryResultError(value: unknown): string {
  const text = String(value || '').trim();
  return /^(?:core (?:add|edit|delete)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(text)
    ? text
    : '';
}

