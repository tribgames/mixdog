/** Comparison key for a project path: separators unified, trailing slash and
 *  surrounding whitespace dropped, case folded (Windows paths are
 *  case-insensitive). The one identity every project lookup compares by. */
export function projectIdentity(path: unknown): string {
  return String(path || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();
}
