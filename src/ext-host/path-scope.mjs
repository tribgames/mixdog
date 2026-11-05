import { isAbsolute, relative, sep } from 'node:path';

/**
 * Whether `target` is `root` or inside it. Leaving the root means the relative path is exactly `..`,
 * starts with a `..` component, or is absolute (another drive); a name that merely begins with two
 * dots (`..notes.docx`) is an ordinary entry.
 */
export function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
