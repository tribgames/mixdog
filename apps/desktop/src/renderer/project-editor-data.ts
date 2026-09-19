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
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        if (target.pending === pending) target.value = value;
        return value;
      })
      .finally(() => {
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
  projectId?: string | null;
};

type CoreMemoryRow = {
  id: number | null;
  element?: string;
  summary?: string;
  source?: string;
  index_revision?: string;
  project_id?: string | null;
};

export function parseCoreMemoryEntries(value: unknown): CoreMemoryEntry[] {
  let structured: unknown = value;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    structured = JSON.parse(value);
  }
  if (structured && typeof structured === 'object' && 'entries' in structured) {
    const rows = (structured as { entries: CoreMemoryRow[] }).entries;
    return rows
      .filter((row): row is CoreMemoryRow & { id: number } => row.source !== 'generated' && row.id !== null)
      .map((row) => ({
        id: row.id,
        element: row.element || '',
        summary: row.summary || row.element || '',
        singleSentence: !row.element || row.element === row.summary,
        indexRevision: row.index_revision,
        projectId: row.project_id ?? null,
      }))
      .sort((a, b) => a.id - b.id);
  }
  const entries: CoreMemoryEntry[] = [];
  for (const line of String(value || '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
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
  return /^(?:core (?:add|edit|delete)(?::| failed)|core:.*(?:not initialized|failed|error)|(?:error|failed)\b)/i.test(
    text
  )
    ? text
    : '';
}

export type ProjectMemoryCatalog = Map<string | null, CoreMemoryEntry[]>;

export async function readProjectMemories(
  paths: string[],
  control: (input: Record<string, unknown>) => Promise<unknown>
): Promise<ProjectMemoryCatalog> {
  const byScope = new Map<string | null, CoreMemoryEntry[]>();
  let projectScopes: Array<{ path: string; projectId: string | null }> = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const value = await control({
      action: 'core',
      op: 'list',
      source: 'curated',
      scope_only: true,
      format: 'json',
      project_id: '*',
      project_paths: paths,
      limit: 100,
      offset,
    });
    const failure = memoryResultError(value);
    if (failure) throw new Error(failure);
    const page = typeof value === 'string' ? JSON.parse(value) : value;
    if (!page || !Array.isArray(page.entries) || !Array.isArray(page.projectScopes)) {
      throw new Error('Memory is temporarily unavailable.');
    }
    projectScopes = page.projectScopes;
    for (const entry of parseCoreMemoryEntries(page)) {
      const scope = entry.projectId ?? null;
      const entries = byScope.get(scope) ?? [];
      if (entries.length && entry.indexRevision !== entries[0].indexRevision) {
        throw new Error('Memory changed. Refresh the list before editing.');
      }
      entries.push(entry);
      byScope.set(scope, entries);
    }
    offset = page.nextOffset ?? null;
  }
  for (const entries of byScope.values()) entries.sort((a, b) => a.id - b.id);
  return new Map([
    [null, byScope.get(null) ?? []],
    ...projectScopes.map(({ path, projectId }): [string, CoreMemoryEntry[]] => [path, byScope.get(projectId) ?? []]),
  ]);
}
