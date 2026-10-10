import type { WorkspaceSelection } from './nav-types';
import { navigationKey } from './text-format';
import { clampPaneRatio, type MigratedAgentSelection, type PaneNode } from './pane-layout';

/** Persistence guard: a deeper stored tree than any real split arrangement
 *  could produce is rejected as corrupt instead of recursed into. */
const PANE_PARSE_DEPTH_LIMIT = 32;

function parseWorkspaceSelection(value: unknown): WorkspaceSelection | null {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  const text = (key: string): string => {
    const raw = record[key];
    return typeof raw === 'string' ? raw : '';
  };
  switch (record.kind) {
    case 'new': {
      const draftId = text('draftId');
      return draftId ? { kind: 'new', draftId } : { kind: 'new' };
    }
    case 'project': {
      const path = text('path');
      return path ? { kind: 'project', path } : null;
    }
    case 'session': {
      const id = text('id');
      if (!id) return null;
      const title = text('title');
      return { kind: 'session', id, ...(title ? { title } : {}) };
    }
    case 'agent-session': {
      const id = text('id');
      const title = text('title');
      if (!id || !title) return null;
      return { kind: 'session', id, title, legacyAgentSelection: true } as MigratedAgentSelection;
    }
    case 'file': {
      const project = text('project');
      const rel = text('rel');
      if (!project || !rel) return null;
      const accessToken = text('accessToken');
      return { kind: 'file', project, rel, ...(accessToken ? { accessToken } : {}) };
    }
    case 'studio': {
      const id = text('id');
      return id ? { kind: 'studio', id } : null;
    }
    case 'terminal': {
      const id = text('id');
      if (!id) return null;
      const cwd = text('cwd');
      return { kind: 'terminal', id, ...(cwd ? { cwd } : {}) };
    }
    case 'browser': {
      const id = text('id');
      const url = text('url');
      if (!id || !url) return null;
      const title = text('title');
      return { kind: 'browser', id, url, ...(title ? { title } : {}) };
    }
    case 'pull-request': {
      const project = text('project');
      const number = Number(record.number);
      const mode = record.mode;
      if (!project || !Number.isInteger(record.number) || number <= 0) return null;
      if (mode !== 'overview' && mode !== 'changes') return null;
      const title = text('title');
      const instanceId = text('instanceId');
      return {
        kind: 'pull-request',
        project,
        number,
        mode,
        ...(title ? { title } : {}),
        ...(instanceId ? { instanceId } : {}),
      };
    }
    case 'diff': {
      const project = text('project');
      const rel = text('rel');
      const source = record.source;
      if (!project || !rel) return null;
      if (source !== 'staged' && source !== 'unstaged' && source !== 'commit' && source !== 'session') return null;
      const hash = text('hash');
      if ((source === 'commit' || source === 'session') && !hash) return null;
      return {
        kind: 'diff',
        project,
        rel,
        source,
        ...(hash ? { hash } : {}),
        ...(record.untracked === true ? { untracked: true } : {}),
      };
    }
    default:
      return null;
  }
}

/** Validate a persisted tree. Any malformed node rejects the WHOLE layout —
 *  a partially restored split arrangement is worse than a fresh single pane. */
export function parsePaneLayout(value: unknown): PaneNode | null {
  const seenIds = new Set<string>();
  const parse = (node: unknown, depth: number): PaneNode | null => {
    if (depth > PANE_PARSE_DEPTH_LIMIT) return null;
    const record = node && typeof node === 'object' ? (node as Record<string, unknown>) : null;
    if (!record) return null;
    if (record.type === 'leaf') {
      const id = typeof record.id === 'string' ? record.id : '';
      if (!id || seenIds.has(id)) return null;
      // Legacy single-selection leaves (pre-tab-group) migrate to a
      // one-tab group instead of invalidating the stored layout.
      let rawTabs: unknown[] = [];
      if (Array.isArray(record.tabs)) rawTabs = record.tabs;
      else if (record.selection !== undefined) rawTabs = [record.selection];
      const tabs: WorkspaceSelection[] = [];
      const keys = new Set<string>();
      for (const value of rawTabs) {
        const selection = parseWorkspaceSelection(value);
        if (!selection) {
          // Browser Use once lived in a retired id-less workspace tab. Drop
          // only that selection while preserving the rest of the layout.
          if (value && typeof value === 'object' && (value as Record<string, unknown>).kind === 'browser') continue;
          return null;
        }
        const key = navigationKey(selection);
        if (keys.has(key)) return null;
        keys.add(key);
        tabs.push(selection);
      }
      seenIds.add(id);
      // A zero-tab leaf is the persisted EMPTY workspace.
      if (tabs.length === 0) return { type: 'leaf', id, tabs, activeKey: '' };
      const activeKey =
        typeof record.activeKey === 'string' && keys.has(record.activeKey) ? record.activeKey : navigationKey(tabs[0]);
      const previewKey =
        typeof record.previewKey === 'string' &&
        keys.has(record.previewKey) &&
        tabs.find((tab) => navigationKey(tab) === record.previewKey)?.kind === 'file'
          ? record.previewKey
          : undefined;
      return { type: 'leaf', id, tabs, activeKey, ...(previewKey ? { previewKey } : {}) };
    }
    if (record.type === 'split') {
      if (record.direction !== 'row' && record.direction !== 'column') return null;
      const first = parse(record.first, depth + 1);
      const second = parse(record.second, depth + 1);
      if (!first || !second) return null;
      return {
        type: 'split',
        direction: record.direction,
        ratio: clampPaneRatio(Number(record.ratio)),
        first,
        second,
      };
    }
    return null;
  };
  return value == null ? null : parse(value, 0);
}
