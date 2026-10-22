import { pathToFileURL } from 'node:url';

/**
 * `text` with every mention of the given directories taken out (and the
 * separator after it), whether written as a native path, with forward slashes
 * or as a file URL, so an error never discloses a private scratch location.
 */
export function redactDirectories(text, directories) {
  let out = String(text ?? '');
  for (const directory of directories) {
    if (!directory) continue;
    const forms = new Set([directory, directory.replaceAll('\\', '/'), pathToFileURL(directory).href]);
    for (const form of [...forms].sort((a, b) => b.length - a.length)) {
      out = out.split(`${form}\\`).join('').split(`${form}/`).join('').split(form).join('');
    }
  }
  return out;
}
