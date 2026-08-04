import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import type {
  DesktopWorkspace,
  DesktopWorkspaceFolder,
} from '../shared/contract';
import type { DesktopEditorSettings } from '../shared/contract';
import { editorLanguageIdForPath } from '../shared/editor-languages';
import { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';
import { objectRecord, parseJsonc, readJsoncFile } from './workflow-config';

const MAX_WORKSPACE_FOLDERS = 64;

export { DEFAULT_DESKTOP_EDITOR_SETTINGS } from '../shared/editor-settings';

function workspaceName(path: string): string {
  return basename(path).replace(/\.code-workspace$/i, '') || 'Workspace';
}

function normalizedFolder(
  value: unknown,
  workspaceFile: string,
): DesktopWorkspaceFolder | null {
  const record = objectRecord(value);
  const rawPath = typeof record?.path === 'string' ? record.path.trim() : '';
  if (!rawPath || rawPath.length > 16_384) return null;
  const path = resolve(dirname(workspaceFile), rawPath);
  return {
    path,
    ...(typeof record?.name === 'string' && record.name.trim()
      ? { name: record.name.trim().slice(0, 200) }
      : {}),
  };
}

function uniqueFolders(folders: readonly DesktopWorkspaceFolder[]): DesktopWorkspaceFolder[] {
  const seen = new Set<string>();
  const result: DesktopWorkspaceFolder[] = [];
  for (const folder of folders) {
    const key = process.platform === 'win32'
      ? resolve(folder.path).toLocaleLowerCase()
      : resolve(folder.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...folder, path: resolve(folder.path) });
    if (result.length >= MAX_WORKSPACE_FOLDERS) break;
  }
  return result;
}

export function parseWorkspaceFile(source: string, workspaceFile: string): DesktopWorkspace {
  const file = resolve(workspaceFile);
  const config = objectRecord(parseJsonc(source));
  if (!config) throw new TypeError('Workspace configuration must be an object.');
  const folders = uniqueFolders((Array.isArray(config.folders) ? config.folders : [])
    .map((folder) => normalizedFolder(folder, file))
    .filter((folder): folder is DesktopWorkspaceFolder => folder !== null));
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

export async function writeWorkspaceFile(
  workspaceFile: string,
  folders: readonly DesktopWorkspaceFolder[],
): Promise<DesktopWorkspace> {
  let file = resolve(workspaceFile);
  if (!file.toLocaleLowerCase().endsWith('.code-workspace')) file += '.code-workspace';
  const normalized = uniqueFolders(folders);
  let existing: Record<string, unknown> = {};
  try {
    existing = (await readJsoncFile(file)) ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  const base = dirname(file);
  const serializedFolders = normalized.map((folder) => {
    const rel = relative(base, folder.path);
    const path = rel && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : folder.path;
    return {
      path: path || '.',
      ...(folder.name ? { name: folder.name } : {}),
    };
  });
  await mkdir(base, { recursive: true });
  await writeFile(file, `${JSON.stringify({
    ...existing,
    folders: serializedFolders,
  }, null, 2)}\n`, 'utf8');
  return {
    kind: 'workspace',
    name: workspaceName(file),
    workspaceFile: file,
    folders: normalized,
  };
}

function languageSettings(
  source: Record<string, unknown>,
  languageId: string,
): Record<string, unknown> {
  let result = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('[') || !key.endsWith(']')) continue;
    const languages = [...key.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
    if (!languages.includes(languageId)) continue;
    result = { ...result, ...(objectRecord(value) ?? {}) };
  }
  return result;
}

function setting(source: Record<string, unknown>, key: string): unknown {
  if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  const [group, ...rest] = key.split('.');
  const nested = objectRecord(source[group]);
  return nested && rest.length ? setting(nested, rest.join('.')) : undefined;
}

function finiteNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function editorSettingsFromScopes(
  scopes: readonly unknown[],
  languageId = 'plaintext',
): DesktopEditorSettings {
  const merged = scopes.reduce<Record<string, unknown>>((current, scope) => {
    const record = objectRecord(scope);
    return record ? { ...current, ...languageSettings(record, languageId) } : current;
  }, {});
  const defaults = DEFAULT_DESKTOP_EDITOR_SETTINGS;
  const wordWrap = setting(merged, 'editor.wordWrap');
  const whitespace = setting(merged, 'editor.renderWhitespace');
  const inlayHints = setting(merged, 'editor.inlayHints.enabled');
  const bracketGuides = setting(merged, 'editor.guides.bracketPairs');
  const fontFamily = setting(merged, 'editor.fontFamily');
  return {
    fontFamily: typeof fontFamily === 'string' && fontFamily.trim()
      ? fontFamily.trim().slice(0, 500)
      : defaults.fontFamily,
    fontSize: finiteNumber(setting(merged, 'editor.fontSize'), defaults.fontSize, 6, 100),
    lineHeight: finiteNumber(setting(merged, 'editor.lineHeight'), defaults.lineHeight, 8, 200),
    wordWrap: wordWrap === 'on' || wordWrap === 'wordWrapColumn' || wordWrap === 'bounded'
      ? wordWrap
      : 'off',
    wordWrapColumn: Math.round(finiteNumber(
      setting(merged, 'editor.wordWrapColumn'),
      defaults.wordWrapColumn,
      1,
      1_000,
    )),
    renderWhitespace: whitespace === 'none' || whitespace === 'boundary'
      || whitespace === 'trailing' || whitespace === 'all'
      ? whitespace
      : 'selection',
    minimapEnabled: booleanSetting(
      setting(merged, 'editor.minimap.enabled'),
      defaults.minimapEnabled,
    ),
    stickyScrollEnabled: booleanSetting(
      setting(merged, 'editor.stickyScroll.enabled'),
      defaults.stickyScrollEnabled,
    ),
    bracketPairColorization: booleanSetting(
      setting(merged, 'editor.bracketPairColorization.enabled'),
      defaults.bracketPairColorization,
    ),
    bracketPairGuides: bracketGuides === true || bracketGuides === false
      || bracketGuides === 'active'
      ? bracketGuides
      : defaults.bracketPairGuides,
    inlayHintsEnabled: inlayHints === false || inlayHints === 'off' ? 'off'
      : inlayHints === 'offUnlessPressed' || inlayHints === 'onUnlessPressed'
        ? inlayHints
        : 'on',
    formatOnSave: booleanSetting(
      setting(merged, 'editor.formatOnSave'),
      defaults.formatOnSave,
    ),
    formatOnPaste: booleanSetting(
      setting(merged, 'editor.formatOnPaste'),
      defaults.formatOnPaste,
    ),
    formatOnType: booleanSetting(
      setting(merged, 'editor.formatOnType'),
      defaults.formatOnType,
    ),
    tabSize: Math.round(finiteNumber(setting(merged, 'editor.tabSize'), defaults.tabSize, 1, 16)),
    insertSpaces: booleanSetting(
      setting(merged, 'editor.insertSpaces'),
      defaults.insertSpaces,
    ),
    detectIndentation: booleanSetting(
      setting(merged, 'editor.detectIndentation'),
      defaults.detectIndentation,
    ),
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

export async function readScopedEditorSettings(
  userDataPath: string,
  folderPath: string,
  relPath: string,
  workspaceFile?: string,
): Promise<DesktopEditorSettings> {
  const user = userDataPath
    ? await optionalJsonc(join(userDataPath, 'User', 'settings.json'))
    : {};
  const workspace = workspaceFile
    ? objectRecord((await optionalJsonc(resolve(workspaceFile))).settings) ?? {}
    : {};
  const folder = await optionalJsonc(join(resolve(folderPath), '.vscode', 'settings.json'));
  return editorSettingsFromScopes(
    [user, workspace, folder],
    editorLanguageIdForPath(relPath),
  );
}
