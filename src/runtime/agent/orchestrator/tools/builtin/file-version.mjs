// The exact metadata version of a buffered file body. Missing/non-finite
// evidence is not equality; never round away a detected sub-ms change.
const FILE_VERSION_FIELDS = ['mtimeMs', 'ctimeMs', 'size', 'ino', 'dev'];

export function sameFileVersion(a, b) {
  return !!a && !!b && FILE_VERSION_FIELDS.every((key) => Number.isFinite(a[key]) && a[key] === b[key]);
}

// Own the fields rather than retaining a mutable Stats/fixture object.
export function fileVersion(stat) {
  if (!sameFileVersion(stat, stat)) return null;
  return Object.fromEntries(FILE_VERSION_FIELDS.map((key) => [key, stat[key]]));
}
