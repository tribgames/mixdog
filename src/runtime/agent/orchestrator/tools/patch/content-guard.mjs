// Content-edit guard: apply_patch rewrites only text files it can snapshot
// for rollback. A binary or oversized target is refused before any mutation,
// from a bounded read of the opened file (never past the 8 MiB limit). The
// readers that consume the bytes afterwards are bounded the same way
// (readPatchTargetBytes), so a target that grows after this check is refused
// there instead of read whole.
import { describeOmittedFile, readBoundedFile } from '../../../../shared/bounded-file-read.mjs';
export function contentEditRefusalMessage(displayPath, omitted) {
  return (
    `apply_patch: ${displayPath} is ${describeOmittedFile(omitted)} — refusing to edit or rename it, ` +
    'because its pre-patch bytes cannot be snapshotted for rollback. Replace or move it with a shell command instead.'
  );
}

/** Refusal text for a content edit of `fullPath`, or null when it may proceed.
 *  Absent/unreadable targets return null: the engine reports those itself. */
export function patchContentEditRefusal(fullPath, displayPath) {
  let read;
  try {
    read = readBoundedFile(fullPath, { classifyOnly: true });
  } catch {
    return null;
  }
  return read.state === 'omitted' ? contentEditRefusalMessage(displayPath, read) : null;
}

/**
 * The bytes of a patch target, read boundedly at the moment they are consumed.
 * Throws ENOENT for an absent target (like readFileSync) and an
 * `EPATCHOMITTED` refusal when it is (now) larger than the snapshot limit.
 * NUL-bearing content is returned: the codec decision belongs to the caller.
 */
export function readPatchTargetBytes(fullPath, displayPath = fullPath) {
  const read = readBoundedFile(fullPath, { detectBinary: false });
  if (read.state === 'absent') {
    const error = new Error(`ENOENT: no such file or directory, open '${fullPath}'`);
    error.code = 'ENOENT';
    throw error;
  }
  if (read.state !== 'present') {
    const error = new Error(contentEditRefusalMessage(displayPath, read));
    error.code = 'EPATCHOMITTED';
    throw error;
  }
  return read.content;
}
