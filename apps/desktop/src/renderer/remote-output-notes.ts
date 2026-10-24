// The host's phone copy of a tool row says what it changed in an output field
// as data (`remoteOutputNotes`, see main/remote-transcript.ts), not as English
// prose. The phone writes the words in its own language. The row keeps its
// text exactly as the host sent it — its collapsed header is parsed from that
// text (the host compares the same parse of the cut and the whole output) —
// and shows its note on a line of its own (`remoteOutputNotice`).
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';

const NOTES_FIELD = 'remoteOutputNotes';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const withheldText = () =>
  t('Output withheld: this tool call touches a secret file, so it is not sent to a remote device.');
const omittedText = (omitted: unknown) => t('… {{omitted}} characters omitted …', { omitted });
const isOmitted = (note: unknown): note is { kind: 'omitted'; at: number; omitted: number } =>
  isRecord(note) && note.kind === 'omitted' && Number.isInteger(note.at) && Number.isInteger(note.omitted);

/** The line a tool row's phone copy shows under its output: that its output
 *  was withheld, or how much of the shown output its cut left out. Empty for a
 *  row that holds its whole output (a merged full read drops the cut marker). */
export function remoteOutputNotice(item: TranscriptItem): string {
  const notes = item[NOTES_FIELD];
  if (!isRecord(notes)) return '';
  if (Object.values(notes).some((note) => isRecord(note) && note.kind === 'withheld')) return withheldText();
  if (!(typeof item.remoteOutputTruncated === 'number' && item.remoteOutputTruncated > 0)) return '';
  const note = notes[item.result != null ? 'result' : 'rawResult'];
  return isOmitted(note) ? omittedText(note.omitted) : '';
}
