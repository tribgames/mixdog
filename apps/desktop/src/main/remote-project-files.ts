// The paired-device side of the editor's text reads and saves. Each reaches
// the file only through openAuthorizedFile: the open file's real location must
// be inside its project (or granted) folder — the boundary the desktop's own
// reads and saves apply (projectEntryPathIn) — and every byte, read or
// written, goes through that handle, so a path swapped for a link between the
// request's checks and the I/O reaches nothing. They run in the desktop
// operation service, beside the desktop's own writes, so they share its
// per-file mutation claims.
import { openAuthorizedFile } from './opened-file-authorization';
import {
  type ProjectTextEncoding,
  type ProjectTextFile,
  projectEntryPathIn,
  readProjectTextFileThrough,
  writeProjectTextFileThrough,
  writeProjectTextFilesThrough,
} from './project-files';

const opener = (root: string) => async (absolute: string) => (await openAuthorizedFile(absolute, root, 'write')).handle;

/** A project (or granted) file's text, read through the authorized handle. */
export async function readProjectTextFileAuthorized(root: string, relPath: string): Promise<ProjectTextFile> {
  const file = await openAuthorizedFile(projectEntryPathIn(root, relPath), root);
  try {
    return await readProjectTextFileThrough(file.handle);
  } finally {
    await file.handle.close();
  }
}

/** A save, checked and written through the authorized handle. */
export function writeProjectTextFileAuthorized(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding: ProjectTextEncoding | undefined
): Promise<{ mtimeMs: number }> {
  return writeProjectTextFileThrough(root, relPath, content, expectedContent, encoding, opener(root));
}

/** A multi-file edit, every file checked and written through its handle. */
export function writeProjectTextFilesAuthorized(
  root: string,
  writes: ReadonlyArray<{ relPath: string; content: string; expectedContent: string }>,
  recoveryDataPath?: string
): Promise<void> {
  return writeProjectTextFilesThrough(root, writes, opener(root), recoveryDataPath);
}
