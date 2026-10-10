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

let revision = 0;
let active: ActiveEditorDocument | null = null;
let activeLine = 1;
let activeColumn = 1;
const lspProblems = new Map<string, EditorProblem[]>();
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

/** A server's status is keyed by project and language, and by file too when
 *  the server answered for one document. */
function statusKey(projectPath: string, languageId: string, relPath?: string): string {
  const suffix = relPath ? `\0${relPath.replace(/\\/g, '/').toLocaleLowerCase()}` : '';
  return `${projectPath}\0${languageId}${suffix}`;
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
  revision += 1;
  snapshot = {
    revision,
    active,
    activeLine,
    activeColumn,
    problems: [...lspProblems.values(), ...nativeProblems.values()].flat(),
    outline: active ? (outlines.get(active.uri) ?? []) : [],
    statuses: [...statuses.values()],
  };
  for (const listener of listeners) listener();
}

function acceptLspDiagnostics(event: DesktopLspDiagnosticEvent): void {
  const rows = event.diagnostics.map(
    (diagnostic, index): EditorProblem => ({
      key: `lsp:${event.uri}:${index}:${diagnostic.range.start.line}:${diagnostic.range.start.character}`,
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
  if (rows.length) lspProblems.set(event.uri, rows);
  else lspProblems.delete(event.uri);
  publish();
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

const documentOwners = new Map<string, { projectPath: string; relPath: string; count: number }>();

function comparableRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').toLocaleLowerCase();
}

/** Register one owner (pane/editor) of a document. Pair with releaseEditorDocument. */
export function acquireEditorDocument(projectPath: string, relPath: string, uri: string): void {
  const owner = documentOwners.get(uri);
  if (owner) owner.count += 1;
  else documentOwners.set(uri, { projectPath, relPath, count: 1 });
}

/** Drop one owner; the last release removes the document's statuses, native
 *  problems and outline and publishes once. */
export function releaseEditorDocument(uri: string): void {
  const owner = documentOwners.get(uri);
  if (!owner) return;
  owner.count -= 1;
  if (owner.count > 0) return;
  documentOwners.delete(uri);
  const rel = comparableRelPath(owner.relPath);
  for (const [key, status] of statuses) {
    if (status.relPath && status.projectPath === owner.projectPath && comparableRelPath(status.relPath) === rel) {
      statuses.delete(key);
    }
  }
  nativeProblems.delete(uri);
  outlines.delete(uri);
  publish();
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
