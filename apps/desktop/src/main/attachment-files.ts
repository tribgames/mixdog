import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requiredAttachmentFile } from './ipc-validation';

/** Writes a `data:` attachment under `<temp>/mixdog-attachments` and returns
 *  its absolute path. Throws before touching disk when the type is not on the
 *  inert-extension allowlist. */
export async function writeAttachmentFile(temp: string, dataUrl: unknown, name: unknown): Promise<string> {
  const attachment = requiredAttachmentFile(dataUrl, name);
  if (!temp) throw new Error('Unable to open file: no temporary directory.');
  const directory = join(temp, 'mixdog-attachments');
  await mkdir(directory, { recursive: true });
  const digest = createHash('sha256').update(attachment.bytes).digest('hex').slice(0, 16);
  const file = join(directory, `${attachment.baseName}-${digest}.${attachment.extension}`);
  await writeFile(file, attachment.bytes, { mode: 0o600 });
  return file;
}
