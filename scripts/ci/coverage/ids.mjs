// Case identity for the release coverage proof (docs/testing.md, "Release coverage"). An identity is a typed array of exact name
// components, never a string that has to be split again: ['node', file, ...suites, leaf], ['rust', manifest, kind, target, path],
// ['python', file, class, test]. Line numbers, matrix indices and ordinals are not part of it. Sets of identities are compared by
// the canonical JSON of the array, so no suffix or case-folding match can pair two different tests.
import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted, arrays in order, no whitespace. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const digestOf = (value) => createHash('sha256').update(canonical(value)).digest('hex');

export function assertId(id) {
  if (!Array.isArray(id) || id.length < 2 || !id.every((part) => typeof part === 'string'))
    throw new Error(`not a case identity: ${JSON.stringify(id)}`);
  return id;
}

export const idKey = (id) => canonical(assertId(id));
export const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `**` crosses folders, `*` and `?` do not. The whole path must match. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

export const matchesAny = (path, globs) => globs.some((glob) => globToRegExp(glob).test(path));
