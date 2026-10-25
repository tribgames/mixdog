import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { DesktopWorkspace, DesktopWorkspaceFolder } from '../shared/contract';
import type { DesktopEditorSettings } from '../shared/contract';
import { editorLanguageIdForPath } from '../shared/editor-languages';
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';
import { applyEdits, modify } from 'jsonc-parser';
import { holdsNoData } from '../../../../src/runtime/shared/atomic-file.mjs';
import { writeUserFile } from './user-file-write';
import { objectRecord, parseJsonc, readJsoncFile } from './workflow-config';

const MAX_WORKSPACE_FOLDERS = 64;

export { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';

function workspaceName(path: string): string {
  return basename(path).replace(/\.code-workspace$/i, '') || 'Workspace';
}

function normalizedFolder(value: unknown, workspaceFile: string): DesktopWorkspaceFolder | null {
  const record = objectRecord(value);
  const rawPath = typeof record?.path === 'string' ? record.path.trim() : '';
  if (!rawPath || rawPath.length > 16_384) return null;
  const path = resolve(dirname(workspaceFile), rawPath);
  return {
    path,
    ...(typeof record?.name === 'string' && record.name.trim() ? { name: record.name.trim().slice(0, 200) } : {}),
  };
}

function uniqueFolders(folders: readonly DesktopWorkspaceFolder[]): DesktopWorkspaceFolder[] {
  const seen = new Set<string>();
  const result: DesktopWorkspaceFolder[] = [];
  for (const folder of folders) {
    const key = process.platform === 'win32' ? resolve(folder.path).toLocaleLowerCase() : resolve(folder.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...folder, path: resolve(folder.path) });
    if (result.length >= MAX_WORKSPACE_FOLDERS) break;
  }
  return result;
}

function parseWorkspaceFile(source: string, workspaceFile: string): DesktopWorkspace {
  const file = resolve(workspaceFile);
  const config = objectRecord(parseJsonc(source));
  if (!config) throw new TypeError('Workspace configuration must be an object.');
  const folders = uniqueFolders(
    (Array.isArray(config.folders) ? config.folders : [])
      .map((folder) => normalizedFolder(folder, file))
      .filter((folder): folder is DesktopWorkspaceFolder => folder !== null)
  );
  return {
    kind: 'workspace',
    name: workspaceName(file),
    workspaceFile: file,
    folders,
  };
}

export async function readWorkspaceFile(workspaceFile: string): Promise<DesktopWorkspace> {
  const file = resolve(workspaceFile);
  if (extname(file).toLocaleLowerCase() !== '.code-workspace') {
    throw new TypeError('Workspace file must use the .code-workspace extension.');
  }
  return parseWorkspaceFile(await readFile(file, 'utf8'), file);
}

/** The `.code-workspace` path a save names (the extension added when absent). */
function workspaceFilePath(workspaceFile: string): string {
  const file = resolve(workspaceFile);
  return file.toLocaleLowerCase().endsWith('.code-workspace') ? file : `${file}.code-workspace`;
}

/** The saved text of workspace `file` listing `folders`, keeping the other
 *  keys of its `existing` configuration, and the workspace it describes. */
function workspaceFileText(
  file: string,
  folders: readonly DesktopWorkspaceFolder[],
  existing: Record<string, unknown>
): { text: string; workspace: DesktopWorkspace } {
  const normalized = uniqueFolders(folders);
  const base = dirname(file);
  const serializedFolders = normalized.map((folder) => {
    const rel = relative(base, folder.path);
    const path = rel && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : folder.path;
    return {
      path: path || '.',
      ...(folder.name ? { name: folder.name } : {}),
    };
  });
  return {
    text: `${JSON.stringify({ ...existing, folders: serializedFolders }, null, 2)}\n`,
    workspace: { kind: 'workspace', name: workspaceName(file), workspaceFile: file, folders: normalized },
  };
}

export async function writeWorkspaceFile(
  workspaceFile: string,
  folders: readonly DesktopWorkspaceFolder[]
): Promise<DesktopWorkspace> {
  const file = workspaceFilePath(workspaceFile);
  let existing: Record<string, unknown> = {};
  try {
    existing = (await readJsoncFile(file)) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const { text, workspace } = workspaceFileText(file, folders, existing);
  await mkdir(dirname(file), { recursive: true });
  await writeUserFile(file, text);
  return workspace;
}

function languageSettings(source: Record<string, unknown>, languageId: string): Record<string, unknown> {
  let result = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('[') || !key.endsWith(']')) continue;
    const languages = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    if (!languages.includes(languageId)) continue;
    result = { ...result, ...(objectRecord(value) ?? {}) };
  }
  return result;
}

function settingInScope(source: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(source, key)) return source[key];
  const [group, ...rest] = key.split('.');
  const nested = objectRecord(source[group]);
  return nested && rest.length ? settingInScope(nested, rest.join('.')) : undefined;
}

/** Resolves dotted/nested forms within each scope first; later scopes win. */
function setting(scopes: readonly Record<string, unknown>[], key: string): unknown {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const value = settingInScope(scopes[i], key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function inlayHintsSetting(value: unknown): DesktopEditorSettings['inlayHintsEnabled'] {
  if (value === false || value === 'off') return 'off';
  if (value === 'offUnlessPressed' || value === 'onUnlessPressed') return value;
  return 'on';
}

function markdownDefaultViewSetting(value: unknown): DesktopEditorSettings['markdownDefaultView'] {
  return value === 'rich' || value === 'source' ? value : 'preview';
}

function editorSettingsFromScopes(scopes: readonly unknown[], languageId = 'plaintext'): DesktopEditorSettings {
  const merged = scopes.flatMap((scope) => {
    const record = objectRecord(scope);
    return record ? [languageSettings(record, languageId)] : [];
  });
  const defaults = DEFAULT_DESKTOP_EDITOR_SETTINGS;
  const wordWrap = setting(merged, 'editor.wordWrap');
  const whitespace = setting(merged, 'editor.renderWhitespace');
  const inlayHints = setting(merged, 'editor.inlayHints.enabled');
  const bracketGuides = setting(merged, 'editor.guides.bracketPairs');
  const fontFamily = setting(merged, 'editor.fontFamily');
  return {
    fontFamily:
      typeof fontFamily === 'string' && fontFamily.trim() ? fontFamily.trim().slice(0, 500) : defaults.fontFamily,
    fontSize: finiteNumber(setting(merged, 'editor.fontSize'), defaults.fontSize, 6, 100),
    lineHeight: finiteNumber(setting(merged, 'editor.lineHeight'), defaults.lineHeight, 8, 200),
    wordWrap: wordWrap === 'on' || wordWrap === 'wordWrapColumn' || wordWrap === 'bounded' ? wordWrap : 'off',
    wordWrapColumn: Math.round(
      finiteNumber(setting(merged, 'editor.wordWrapColumn'), defaults.wordWrapColumn, 1, 1_000)
    ),
    renderWhitespace:
      whitespace === 'none' || whitespace === 'boundary' || whitespace === 'trailing' || whitespace === 'all'
        ? whitespace
        : 'selection',
    minimapEnabled: booleanSetting(setting(merged, 'editor.minimap.enabled'), defaults.minimapEnabled),
    stickyScrollEnabled: booleanSetting(setting(merged, 'editor.stickyScroll.enabled'), defaults.stickyScrollEnabled),
    bracketPairColorization: booleanSetting(
      setting(merged, 'editor.bracketPairColorization.enabled'),
      defaults.bracketPairColorization
    ),
    bracketPairGuides:
      bracketGuides === true || bracketGuides === false || bracketGuides === 'active'
        ? bracketGuides
        : defaults.bracketPairGuides,
    inlayHintsEnabled: inlayHintsSetting(inlayHints),
    formatOnSave: booleanSetting(setting(merged, 'editor.formatOnSave'), defaults.formatOnSave),
    formatOnPaste: booleanSetting(setting(merged, 'editor.formatOnPaste'), defaults.formatOnPaste),
    formatOnType: booleanSetting(setting(merged, 'editor.formatOnType'), defaults.formatOnType),
    markdownDefaultView: markdownDefaultViewSetting(setting(merged, 'mixdog.markdown.defaultView')),
    tabSize: Math.round(finiteNumber(setting(merged, 'editor.tabSize'), defaults.tabSize, 1, 16)),
    insertSpaces: booleanSetting(setting(merged, 'editor.insertSpaces'), defaults.insertSpaces),
    detectIndentation: booleanSetting(setting(merged, 'editor.detectIndentation'), defaults.detectIndentation),
  };
}

async function optionalJsonc(path: string): Promise<Record<string, unknown>> {
  try {
    return (await readJsoncFile(path)) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
}

const MARKDOWN_DEFAULT_VIEW_KEY = 'mixdog.markdown.defaultView';

function userSettingsFile(userDataPath: string): string {
  return join(userDataPath, 'User', 'settings.json');
}

/** The user-scope Markdown default view (what Settings → General shows),
 *  resolved by the same logic the editor uses. */
export async function readMarkdownDefaultView(
  userDataPath: string
): Promise<DesktopEditorSettings['markdownDefaultView']> {
  const user = userDataPath ? await optionalJsonc(userSettingsFile(userDataPath)) : {};
  return editorSettingsFromScopes([user]).markdownDefaultView;
}

/** Writes the user-scope setting into settings.json as a structural edit, so
 *  comments and formatting stay as written. An unparsable file is left alone. */
export async function writeMarkdownDefaultView(
  userDataPath: string,
  view: DesktopEditorSettings['markdownDefaultView'],
  hooks?: MarkdownWriteHooks
): Promise<DesktopEditorSettings['markdownDefaultView']> {
  const next = markdownDefaultViewSetting(view);
  const file = userSettingsFile(userDataPath);
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => writeMarkdownDefaultViewNow(file, next, hooks));
  writeQueues.set(file, run);
  try {
    await run;
  } finally {
    if (writeQueues.get(file) === run) writeQueues.delete(file);
  }
  return next;
}

const writeQueues = new Map<string, Promise<void>>();

function detectFormatting(source: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(source)?.[1];
  if (!indent) return { insertSpaces: true, tabSize: 2, eol };
  if (indent.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent.length, eol };
}

const READ_RETRIES = 5;
const READ_RETRY_DELAY_MS = 20;
const COMMIT_ATTEMPTS = 5;

/** Test seam: runs after the text is read and before the commit re-check. */
export interface MarkdownWriteHooks {
  afterRead?: () => Promise<void>;
}

/** Reads the file; a missing or empty read is retried briefly because another
 *  process may be mid-replace. Only a persistent miss counts as "no content". */
async function readSettingsText(file: string): Promise<string> {
  let source = '';
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      source = '';
    }
    if (source.trim()) return source;
    await new Promise((done) => setTimeout(done, READ_RETRY_DELAY_MS));
  }
  return source;
}

async function writeMarkdownDefaultViewNow(
  file: string,
  next: DesktopEditorSettings['markdownDefaultView'],
  hooks?: MarkdownWriteHooks
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    const original = await readSettingsText(file);
    await hooks?.afterRead?.();
    const formatting = detectFormatting(original);
    // An empty or NUL-filled settings file means no settings yet.
    const source = holdsNoData(original) ? '{}' : original;
    let parsed: unknown;
    try {
      parsed = parseJsonc(source);
    } catch (error) {
      throw new TypeError(`User settings could not be parsed; refusing to overwrite: ${(error as Error).message}`);
    }
    if (!objectRecord(parsed)) throw new TypeError('User settings must be an object.');
    const edits = modify(source, [MARKDOWN_DEFAULT_VIEW_KEY], next, { formattingOptions: formatting });
    const updated = applyEdits(source, edits);
    // Re-check the target right before replacing it; if it changed, redo on fresh text.
    if ((await readSettingsText(file)) !== original) continue;
    await writeUserFile(file, updated);
    return;
  }
  throw new Error('User settings kept changing during write; giving up without overwriting.');
}
export async function readScopedEditorSettings(
  userDataPath: string,
  folderPath: string,
  relPath: string,
  workspaceFile?: string
): Promise<DesktopEditorSettings> {
  const user = userDataPath ? await optionalJsonc(join(userDataPath, 'User', 'settings.json')) : {};
  const workspace = workspaceFile ? (objectRecord((await optionalJsonc(resolve(workspaceFile))).settings) ?? {}) : {};
  const folder = await optionalJsonc(join(resolve(folderPath), '.vscode', 'settings.json'));
  return editorSettingsFromScopes([user, workspace, folder], editorLanguageIdForPath(relPath));
}
