import type {
  DesktopApi,
  DesktopLspCapabilities,
  DesktopLspDiagnostic,
  DesktopLspDiagnosticEvent,
  DesktopLspServerState,
  DesktopLspStatusEvent,
} from '../shared/contract';
import { recordOrNull } from './record-utils';

export interface EditorProblem {
  key: string;
  projectPath: string;
  relPath: string;
  uri: string;
  origin: 'lsp' | 'native';
  severity: number;
  message: string;
  source: string;
  code: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditorOutlineItem {
  key: string;
  projectPath: string;
  relPath: string;
  uri: string;
  name: string;
  detail: string;
  kind: string;
  line: number;
  column: number;
  endLine?: number;
  level: number;
}

interface ActiveEditorDocument {
  projectPath: string;
  relPath: string;
  uri: string;
  languageId: string;
}

interface EditorLanguageSnapshot {
  revision: number;
  active: ActiveEditorDocument | null;
  activeLine: number;
  activeColumn: number;
  problems: readonly EditorProblem[];
  outline: readonly EditorOutlineItem[];
  statuses: readonly DesktopLspStatusEvent[];
}

interface EditorCommandCapabilities {
  declaration: boolean;
  definition: boolean;
  typeDefinition: boolean;
  implementation: boolean;
  references: boolean;
  signatureHelp: boolean;
  rename: boolean;
  codeAction: boolean;
  formatting: boolean;
  rangeFormatting: boolean;
  callHierarchy: boolean;
}

const EMPTY_COMMAND_CAPABILITIES: EditorCommandCapabilities = Object.freeze({
  declaration: false,
  definition: false,
  typeDefinition: false,
  implementation: false,
  references: false,
  signatureHelp: false,
  rename: false,
  codeAction: false,
  formatting: false,
  rangeFormatting: false,
  callHierarchy: false,
});

interface NativeMarker {
  severity: number;
  message: string;
  source?: string;
  code?: string | number | { value: string | number };
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface LspDiagnosticEntry {
  projectPath: string;
  relPath: string;
  server: string;
  problems: EditorProblem[];
}

let revision = 0;
let active: ActiveEditorDocument | null = null;
let activeLine = 1;
let activeColumn = 1;
const lspDiagnostics = new Map<string, Map<string, LspDiagnosticEntry>>();
const nativeProblems = new Map<string, EditorProblem[]>();
const outlines = new Map<string, EditorOutlineItem[]>();
const statuses = new Map<string, DesktopLspStatusEvent>();
const listeners = new Set<() => void>();
let snapshot: EditorLanguageSnapshot = {
  revision,
  active,
  activeLine,
  activeColumn,
  problems: [],
  outline: [],
  statuses: [],
};
let commandCapabilities: EditorCommandCapabilities = EMPTY_COMMAND_CAPABILITIES;
let boundApi: DesktopApi | null = null;
let unsubscribeDiagnostics: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

function markerCode(value: NativeMarker['code'] | DesktopLspDiagnostic['code']): string {
  if (value && typeof value === 'object' && 'value' in value) return String(value.value);
  return value == null ? '' : String(value);
}

const COMMAND_CAPABILITY_KEYS = Object.keys(EMPTY_COMMAND_CAPABILITIES) as Array<keyof EditorCommandCapabilities>;

function commandCapabilitiesOf(capabilities: DesktopLspCapabilities): EditorCommandCapabilities {
  const next = { ...EMPTY_COMMAND_CAPABILITIES };
  for (const key of COMMAND_CAPABILITY_KEYS) next[key] = capabilities[key];
  return next;
}

const WINDOWS_PATH_SHAPE = /^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/])/;

function isCaseInsensitiveProject(projectPath: string): boolean {
  return WINDOWS_PATH_SHAPE.test(projectPath);
}

export function normalizeProjectPath(projectPath: string): string {
  if (!projectPath) return '';
  if (isCaseInsensitiveProject(projectPath)) {
    const slashed = projectPath.replace(/\\/g, '/');
    if (/^[A-Za-z]:\/+$/.test(slashed)) return `${slashed.slice(0, 2).toLowerCase()}/`;
    return slashed.replace(/\/+$/, '').toLowerCase();
  }
  if (/^\/+$/.test(projectPath)) return '/';
  return projectPath.replace(/\/+$/, '');
}

export function lspMarkerOwner(projectPath: string): string {
  return `mixdog-lsp:${normalizeProjectPath(projectPath)}`;
}

export function isLspMarkerOwner(owner: string): boolean {
  return owner === 'mixdog-lsp' || owner.startsWith('mixdog-lsp:');
}

function comparableRelPath(projectPath: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  return isCaseInsensitiveProject(projectPath) ? normalized.toLowerCase() : normalized;
}

/** A server's status is keyed by project and language, and by file too when
 *  the server answered for one document. */
function statusKey(projectPath: string, languageId: string, relPath?: string): string {
  const suffix = relPath ? `\0${comparableRelPath(projectPath, relPath)}` : '';
  return `${normalizeProjectPath(projectPath)}\0${languageId}${suffix}`;
}

function publish(): void {
  const status = active
    ? (statuses.get(statusKey(active.projectPath, active.languageId, active.relPath)) ??
      statuses.get(statusKey(active.projectPath, active.languageId)))
    : undefined;
  const capabilities = status?.available ? status.capabilities : undefined;
  const nextCommandCapabilities = capabilities ? commandCapabilitiesOf(capabilities) : EMPTY_COMMAND_CAPABILITIES;
  if (COMMAND_CAPABILITY_KEYS.some((key) => commandCapabilities[key] !== nextCommandCapabilities[key])) {
    commandCapabilities = nextCommandCapabilities;
  }
  const lspProblemLists: EditorProblem[][] = [];
  for (const byProject of lspDiagnostics.values()) {
    for (const entry of byProject.values()) lspProblemLists.push(entry.problems);
  }
  revision += 1;
  snapshot = {
    revision,
    active,
    activeLine,
    activeColumn,
    problems: [...lspProblemLists, ...nativeProblems.values()].flat(),
    outline: active ? (outlines.get(active.uri) ?? []) : [],
    statuses: [...statuses.values()],
  };
  for (const listener of listeners) listener();
}

function sameProblems(left: readonly EditorProblem[] | undefined, right: readonly EditorProblem[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.key !== b.key ||
      a.projectPath !== b.projectPath ||
      a.relPath !== b.relPath ||
      a.uri !== b.uri ||
      a.origin !== b.origin ||
      a.severity !== b.severity ||
      a.message !== b.message ||
      a.source !== b.source ||
      a.code !== b.code ||
      a.startLineNumber !== b.startLineNumber ||
      a.startColumn !== b.startColumn ||
      a.endLineNumber !== b.endLineNumber ||
      a.endColumn !== b.endColumn
    ) {
      return false;
    }
  }
  return true;
}

function acceptLspDiagnostics(event: DesktopLspDiagnosticEvent): void {
  const projectKey = normalizeProjectPath(event.projectPath);
  const rows = (Array.isArray(event.diagnostics) ? event.diagnostics : []).map(
    (diagnostic, index): EditorProblem => ({
      key: `lsp:${projectKey}:${event.uri}:${index}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`,
      projectPath: event.projectPath,
      relPath: event.relPath,
      uri: event.uri,
      origin: 'lsp',
      severity: Number(diagnostic.severity || 3),
      message: String(diagnostic.message || ''),
      source: String(diagnostic.source || event.server || ''),
      code: markerCode(diagnostic.code),
      startLineNumber: Math.max(1, Number(diagnostic.range.start.line) + 1),
      startColumn: Math.max(1, Number(diagnostic.range.start.character) + 1),
      endLineNumber: Math.max(1, Number(diagnostic.range.end.line) + 1),
      endColumn: Math.max(1, Number(diagnostic.range.end.character) + 1),
    })
  );
  if (rows.length) {
    let byProject = lspDiagnostics.get(event.uri);
    const previous = byProject?.get(projectKey);
    if (
      previous &&
      sameProblems(previous.problems, rows) &&
      previous.projectPath === event.projectPath &&
      previous.relPath === event.relPath &&
      previous.server === event.server
    ) {
      return;
    }
    if (!byProject) {
      byProject = new Map();
      lspDiagnostics.set(event.uri, byProject);
    }
    byProject.set(projectKey, {
      projectPath: event.projectPath,
      relPath: event.relPath,
      server: event.server,
      problems: rows,
    });
  } else {
    const byProject = lspDiagnostics.get(event.uri);
    if (!byProject?.delete(projectKey)) return;
    if (byProject.size === 0) lspDiagnostics.delete(event.uri);
  }
  publish();
}

/** A stopped server publishes nothing more: what it last reported goes with it. */
function dropStoppedServerDiagnostics(event: DesktopLspStatusEvent): void {
  if (event.status !== 'stopped') return;
  const projectKey = normalizeProjectPath(event.projectPath);
  for (const [uri, byProject] of lspDiagnostics) {
    const owner = byProject.get(projectKey);
    if (!owner || owner.server !== event.server) continue;
    byProject.delete(projectKey);
    if (byProject.size === 0) lspDiagnostics.delete(uri);
  }
}

export function ensureEditorLanguageStore(): void {
  const api = window.mixdogDesktop ?? null;
  if (api === boundApi) return;
  unsubscribeDiagnostics?.();
  unsubscribeStatus?.();
  boundApi = api;
  unsubscribeDiagnostics = api?.subscribeLspDiagnostics?.(acceptLspDiagnostics) ?? null;
  unsubscribeStatus =
    api?.subscribeLspStatus?.((event) => {
      dropStoppedServerDiagnostics(event);
      statuses.set(statusKey(event.projectPath, event.languageId, event.relPath), event);
      publish();
    }) ?? null;
}

/** A document's own open/sync answer carries its server state. Recorded like
 *  a status broadcast, because a renderer that subscribed after the server
 *  announced itself (a reload while the service kept running) never receives
 *  one and left every palette editor command disabled. */
export function acceptEditorLspState(
  projectPath: string,
  relPath: string,
  languageId: string,
  state: DesktopLspServerState
): void {
  ensureEditorLanguageStore();
  const key = statusKey(projectPath, languageId, relPath);
  const previous = statuses.get(key);
  if (
    previous &&
    previous.available === state.available &&
    previous.status === state.status &&
    JSON.stringify(previous.capabilities ?? null) === JSON.stringify(state.capabilities ?? null)
  )
    return;
  statuses.set(key, { ...state, projectPath, languageId, relPath });
  publish();
}

export function subscribeEditorLanguageStore(listener: () => void): () => void {
  ensureEditorLanguageStore();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorLanguageSnapshot(): EditorLanguageSnapshot {
  ensureEditorLanguageStore();
  return snapshot;
}

export function getEditorCommandCapabilities(): EditorCommandCapabilities {
  return commandCapabilities;
}

export function setActiveEditorDocument(next: ActiveEditorDocument): void {
  if (
    active?.uri === next.uri &&
    active.projectPath === next.projectPath &&
    active.relPath === next.relPath &&
    active.languageId === next.languageId
  )
    return;
  if (active?.uri !== next.uri) {
    activeLine = 1;
    activeColumn = 1;
  }
  active = next;
  publish();
}

export function setActiveEditorPosition(uri: string, line: number, column = 1): void {
  if (active?.uri !== uri) return;
  const nextLine = Math.max(1, Math.round(line));
  const nextColumn = Math.max(1, Math.round(column));
  if (activeLine === nextLine && activeColumn === nextColumn) return;
  activeLine = nextLine;
  activeColumn = nextColumn;
  publish();
}

const documentOwners = new Map<string, Map<string, { projectPath: string; relPath: string; count: number }>>();

/** Register one owner (pane/editor) of a document. Pair with releaseEditorDocument. */
export function acquireEditorDocument(projectPath: string, relPath: string, uri: string): void {
  const projectKey = normalizeProjectPath(projectPath);
  let byProject = documentOwners.get(uri);
  if (!byProject) {
    byProject = new Map();
    documentOwners.set(uri, byProject);
  }
  const owner = byProject.get(projectKey);
  if (owner) owner.count += 1;
  else byProject.set(projectKey, { projectPath, relPath, count: 1 });
}

/** Drop one owner; when an owner's last reference releases, removes that project's
 *  document statuses and diagnostics, clears shared native problems/outline once
 *  no project still holds the URI, and returns true. */
export function releaseEditorDocument(uri: string, projectPath?: string): boolean {
  const byProject = documentOwners.get(uri);
  if (!byProject) return false;
  const projectKey =
    projectPath !== undefined ? normalizeProjectPath(projectPath) : (byProject.keys().next().value as string);
  const owner = byProject.get(projectKey);
  if (!owner) return false;
  owner.count -= 1;
  if (owner.count > 0) return false;
  byProject.delete(projectKey);
  const rel = comparableRelPath(owner.projectPath, owner.relPath);
  for (const [key, status] of statuses) {
    if (
      status.relPath &&
      normalizeProjectPath(status.projectPath) === projectKey &&
      comparableRelPath(status.projectPath, status.relPath) === rel
    ) {
      statuses.delete(key);
    }
  }
  for (const [lspUri, diagByProject] of lspDiagnostics) {
    const from = diagByProject.get(projectKey);
    if (from && comparableRelPath(from.projectPath, from.relPath) === rel) {
      diagByProject.delete(projectKey);
      if (diagByProject.size === 0) lspDiagnostics.delete(lspUri);
    }
  }
  if (byProject.size === 0) {
    documentOwners.delete(uri);
    nativeProblems.delete(uri);
    outlines.delete(uri);
  }
  publish();
  return true;
}

/** Binds one editor pane's model to the language store with per-project marker ownership
 *  and safe teardown ordering (unsubscribe before releasing so publish cannot re-enter). */
export function bindEditorModelLanguageStore({
  projectPath,
  relPath,
  uri,
  getLanguageId,
  isDisposed,
  acceptLspState,
  lspMarkerSignature,
  setMarkers,
}: {
  projectPath: string;
  relPath: string;
  uri: string;
  getLanguageId(): string;
  isDisposed(): boolean;
  acceptLspState(state: DesktopLspServerState, languageId: string): void;
  lspMarkerSignature: { current: string };
  setMarkers(owner: string, problems: readonly EditorProblem[]): void;
}): { dispose(): void } {
  ensureEditorLanguageStore();
  const markerOwner = lspMarkerOwner(projectPath);
  const projectKey = normalizeProjectPath(projectPath);
  const relKey = comparableRelPath(projectPath, relPath);
  acquireEditorDocument(projectPath, relPath, uri);
  let disposed = false;

  const syncLanguageState = (): void => {
    if (disposed || isDisposed()) return;
    const languageSnapshot = getEditorLanguageSnapshot();
    const languageId = getLanguageId();
    const status =
      languageSnapshot.statuses.find(
        (candidate) =>
          normalizeProjectPath(candidate.projectPath) === projectKey &&
          candidate.languageId === languageId &&
          candidate.relPath !== undefined &&
          comparableRelPath(candidate.projectPath, candidate.relPath) === relKey
      ) ??
      languageSnapshot.statuses.find(
        (candidate) =>
          normalizeProjectPath(candidate.projectPath) === projectKey &&
          candidate.languageId === languageId &&
          !candidate.relPath
      );
    if (status) acceptLspState(status, languageId);
    const problems = languageSnapshot.problems.filter(
      (problem) =>
        problem.origin === 'lsp' &&
        normalizeProjectPath(problem.projectPath) === projectKey &&
        comparableRelPath(problem.projectPath, problem.relPath) === relKey
    );
    const signature = JSON.stringify(
      problems.map((problem) => [
        problem.severity,
        problem.message,
        problem.startLineNumber,
        problem.startColumn,
        problem.endLineNumber,
        problem.endColumn,
      ])
    );
    if (signature === lspMarkerSignature.current) return;
    lspMarkerSignature.current = signature;
    setMarkers(markerOwner, problems);
  };

  const unsubscribeStore = subscribeEditorLanguageStore(syncLanguageState);
  syncLanguageState();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribeStore();
      const releasedOwner = releaseEditorDocument(uri, projectPath);
      if (releasedOwner && !isDisposed()) {
        lspMarkerSignature.current = '';
        setMarkers(markerOwner, []);
      }
    },
  };
}

export function clearActiveEditorDocument(uri: string): void {
  outlines.delete(uri);
  if (active?.uri !== uri) return;
  active = null;
  activeLine = 1;
  activeColumn = 1;
  publish();
}

function problemSeverity(markerSeverity: number): 1 | 2 | 3 | 4 {
  if (markerSeverity >= 8) return 1;
  if (markerSeverity >= 4) return 2;
  return markerSeverity >= 2 ? 3 : 4;
}

export function setNativeEditorProblems(
  projectPath: string,
  relPath: string,
  uri: string,
  markers: readonly NativeMarker[]
): void {
  const rows = markers.map(
    (marker, index): EditorProblem => ({
      key: `native:${uri}:${index}:${marker.startLineNumber}:${marker.startColumn}`,
      projectPath,
      relPath,
      uri,
      origin: 'native',
      severity: problemSeverity(marker.severity),
      message: marker.message,
      source: marker.source || '',
      code: markerCode(marker.code),
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    })
  );
  if (rows.length) nativeProblems.set(uri, rows);
  else nativeProblems.delete(uri);
  publish();
}

export function setEditorOutline(uri: string, rows: readonly EditorOutlineItem[]): void {
  if (rows.length) outlines.set(uri, [...rows]);
  else outlines.delete(uri);
  if (active?.uri === uri) publish();
}

function textOffset(content: string, rawPosition: unknown): number {
  const position = recordOrNull(rawPosition);
  const line = Math.max(0, Number(position?.line) || 0);
  const character = Math.max(0, Number(position?.character) || 0);
  let start = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = content.indexOf('\n', start);
    if (newline < 0) return content.length;
    start = newline + 1;
  }
  const newline = content.indexOf('\n', start);
  const end = newline < 0 ? content.length : newline;
  return Math.min(end, start + character);
}

/** Apply non-overlapping LSP UTF-16 text ranges from the end of the file so
 *  earlier offsets remain stable. Shared by unopened-file persistence and
 *  its pure renderer regression contract. */
export function applyLspTextEdits(content: string, edits: readonly Record<string, unknown>[]): string {
  const offsets = edits
    .map((edit) => {
      const range = recordOrNull(edit.range);
      return {
        start: textOffset(content, range?.start),
        end: textOffset(content, range?.end),
        text: String(edit.newText ?? ''),
      };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index].start < offsets[index - 1].end) {
      throw new Error('Language server returned overlapping text edits.');
    }
  }
  let next = content;
  for (const edit of offsets.reverse()) {
    next = `${next.slice(0, edit.start)}${edit.text}${next.slice(edit.end)}`;
  }
  return next;
}
