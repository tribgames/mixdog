import { readFile } from 'node:fs/promises';

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
    return objectRecord(parseJsonc(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
