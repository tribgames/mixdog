// The files a bot's or agent's turn handed back (session-runtime/
// handoff-attachments.mjs collectTurnArtifacts) as the rows that carry them
// show them: one model-facing line per file — the attachment id that forwards
// it, or its path when it is too large or of a type no prompt carries — and
// the message attachment records of the stored ones. Only those records
// authorize forwarding by id; the lines are information for the model.
import { escapeHarnessTags } from './shell-output-summary.mjs';
import { normalizeMessageAttachments } from './transcript-metadata.mjs';

const sizeLabel = (size) => {
  const bytes = Number(size) || 0;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
};

const oneLine = (value) => escapeHarnessTags(String(value ?? '').replace(/[\r\n]+/g, ' '));

/** `files` ({ name, mimeType, size, path, id? }) normalized: bounded strings,
 *  ids only of the attachment-store shape. */
export function normalizeHandoffFiles(files) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && typeof file === 'object' && typeof file.path === 'string' && file.path)
    .slice(0, 8)
    .map((file) => ({
      name: String(file.name || 'file').slice(0, 200),
      path: file.path.slice(0, 1024),
      kind: ['image', 'file', 'text'].includes(file.kind) ? file.kind : 'file',
      mimeType: String(file.mimeType || 'application/octet-stream').slice(0, 100),
      size: Number(file.size) >= 0 ? Number(file.size) : 0,
      ...(/^[a-f0-9]{64}$/.test(String(file.id ?? '')) ? { id: file.id } : {}),
    }));
}

/** An agent completion's compact list of files it produced (name and path
 *  only; the Lead forwards or links by path), empty when there are none. */
export function producedFileLines(files, omitted = 0) {
  const list = normalizeHandoffFiles(files);
  if (!list.length) return [];
  return [
    'Files produced:',
    ...list.map((file) => `- ${oneLine(file.name)} — ${oneLine(file.path)}`),
    ...(omitted > 0 ? [`- …and ${omitted} more`] : []),
  ];
}

/** The model-facing list of a bot task report's `files`, empty when there are
 *  none; the row also records the stored files as its attachments, so their
 *  ids can be forwarded. */
export function artifactLines(files, omitted = 0) {
  const list = normalizeHandoffFiles(files);
  if (!list.length) return [];
  return [
    'Files from this turn (forward one with attachments: [id or path]; link a path to show it):',
    ...list.map(
      (file) =>
        `- ${oneLine(file.name)} (${oneLine(file.mimeType)}, ${sizeLabel(file.size)}) — ${oneLine(file.path)}${
          file.id ? ` [attachment:${file.id}]` : ' (too large or unsupported to attach; link the path)'
        }`
    ),
    ...(omitted > 0 ? [`- …and ${omitted} more file(s)`] : []),
  ];
}

/** The message attachment records of `files` (the stored ones). */
export function artifactRecords(files) {
  return normalizeMessageAttachments(
    normalizeHandoffFiles(files)
      .filter((file) => file.id)
      .map((file) => ({ ...file, attachmentRef: file.id }))
  );
}
