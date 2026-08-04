import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

function stripJsonComments(source: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      result += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') result += '\n';
        index += 1;
      }
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function stripTrailingCommas(source: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === ',') {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === '}' || source[cursor] === ']') continue;
    }
    result += char;
  }
  return result;
}

export function parseJsonc(source: string): unknown {
  if (typeof source !== 'string' || source.length > 2_000_000) {
    throw new TypeError('JSON configuration is too large.');
  }
  return JSON.parse(stripTrailingCommas(stripJsonComments(source)));
}

export async function readJsoncFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = parseJsonc(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface WorkspaceVariableContext {
  workspaceFolder: string;
  file?: string;
}

export function resolveWorkspaceString(
  value: string,
  context: WorkspaceVariableContext,
): string {
  const file = context.file
    ? resolve(context.workspaceFolder, context.file)
    : '';
  return value
    .replace(/\$\{workspaceFolder\}/g, context.workspaceFolder)
    .replace(/\$\{workspaceFolderBasename\}/g, basename(context.workspaceFolder))
    .replace(/\$\{file\}/g, file)
    .replace(/\$\{relativeFile\}/g, context.file || '')
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] || '');
}

export function resolveWorkspaceValue(
  value: unknown,
  context: WorkspaceVariableContext,
  depth = 0,
): unknown {
  if (depth > 20) throw new TypeError('Workspace variable input is too deeply nested.');
  if (typeof value === 'string') return resolveWorkspaceString(value, context);
  if (Array.isArray(value)) {
    return value.map((entry) => resolveWorkspaceValue(entry, context, depth + 1));
  }
  const record = objectRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record)
    .map(([key, entry]) => [key, resolveWorkspaceValue(entry, context, depth + 1)]));
}
