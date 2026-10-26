// A conversation's attachments by id. The bytes live once, in the daemon's
// content-addressed attachment store; a message names them by content hash
// (`meta.transcript.attachments`, or an image's own `attachmentRef` in older
// messages). Any device opens or downloads an attachment by that id, and the
// host serves an id only when THIS session's transcript names it.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { FileDownloadError } from '../shared/file-downloads';
import type { DesktopService } from './desktop-service-contract';
import { sanitizedFileName } from './ipc-validation';
import { type SessionAttachment, sessionAttachments } from './transcript-file-links';

export type AttachmentHost = Pick<DesktopService, 'readAttachmentImage' | 'readSessionTranscript' | 'readSessionHistory'>;

export function requiredAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('attachment id is invalid.');
  return value;
}

/** The attachment this session's conversation names by `id`. The transcript
 *  the host holds is a window (a tail plus the pages paged in), and a
 *  compaction moves older rows into the archive, so a chip the pane still
 *  shows can name an id only the session's whole stored conversation holds:
 *  that is read when the window does not name it. */
async function namedAttachment(host: AttachmentHost, sessionId: string, id: string): Promise<SessionAttachment | undefined> {
  const windowed = host.readSessionTranscript ? await host.readSessionTranscript(sessionId) : null;
  const found = windowed ? sessionAttachments(windowed).get(id) : undefined;
  if (found) return found;
  const history = host.readSessionHistory ? await host.readSessionHistory(sessionId) : null;
  return history ? sessionAttachments(history).get(id) : undefined;
}

/** The attachment of `sessionId` with this id and its verified bytes. Rejects
 *  `not-linked` for an id the session's conversation does not name (another
 *  session's, a guessed hash), `not-found` when the store no longer has it. */
export async function readSessionAttachment(
  host: AttachmentHost,
  sessionId: string,
  attachmentId: unknown
): Promise<{ meta: SessionAttachment; bytes: Buffer }> {
  const id = requiredAttachmentId(attachmentId);
  const meta = await namedAttachment(host, sessionId, id);
  if (!meta) throw new FileDownloadError('not-linked', 'This conversation has no such attachment.');
  const base64 = await host.readAttachmentImage(id);
  if (!base64) throw new FileDownloadError('not-found', 'This attachment is no longer stored on the PC.');
  const bytes = Buffer.from(base64, 'base64');
  // The store is content-addressed: bytes that do not hash to the id are not it.
  if (createHash('sha256').update(bytes).digest('hex') !== id) {
    throw new FileDownloadError('changed', 'The stored attachment failed its integrity check.');
  }
  return { meta, bytes };
}

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
};

/** A file name that previews by its extension: the attachment's own name, or
 *  its media type's extension when the name has none. */
export function attachmentViewName(meta: SessionAttachment): string {
  const name = sanitizedFileName(meta.name);
  return extname(name) ? name : `${name}${EXTENSIONS[meta.mimeType.toLowerCase()] ?? ''}`;
}

/** Writes the attachment to `<temp>/mixdog-attachments/<id>-<name>` (the same
 *  temp convention as an opened data: attachment) and returns its path, so
 *  the file previews through the ordinary file preview paths. */
export async function stageSessionAttachment(temp: string, meta: SessionAttachment, bytes: Buffer): Promise<string> {
  if (!temp) throw new Error('Unable to open file: no temporary directory.');
  const directory = join(temp, 'mixdog-attachments');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${meta.id.slice(0, 16)}-${attachmentViewName(meta)}`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}
