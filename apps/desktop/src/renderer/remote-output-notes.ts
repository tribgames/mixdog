// The host's phone copy of a tool row says what it changed in a text field as
// data (`remoteOutputNotes`, see main/remote-transcript.ts), not as English
// prose. This writes the words, in the phone's language, once a snapshot has
// been decoded; the decoder's own held rows stay as the host sent them.
import type { SessionSnapshot } from '../shared/contract';
import { t } from './i18n';

const NOTES_FIELD = 'remoteOutputNotes';
const localizedRows = new WeakMap<object, Record<string, unknown>>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function noteText(text: string, note: unknown): string {
  if (!isRecord(note)) return text;
  if (note.kind === 'withheld') {
    return t('Output withheld: this tool call touches a secret file, so it is not sent to a remote device.');
  }
  if (note.kind === 'omitted' && Number.isInteger(note.at) && Number.isInteger(note.omitted)) {
    const at = note.at as number;
    return `${text.slice(0, at)}\n[${t('… {{omitted}} characters omitted …', { omitted: note.omitted })}]\n${text.slice(at)}`;
  }
  return text;
}

/** `record` with its noted text fields written out, or `record` itself. */
function localizedRecord(record: Record<string, unknown>): Record<string, unknown> {
  const notes = record[NOTES_FIELD];
  if (!isRecord(notes)) return record;
  const { [NOTES_FIELD]: _notes, ...rest } = record;
  for (const [field, note] of Object.entries(notes)) {
    if (typeof rest[field] === 'string') rest[field] = noteText(rest[field], note);
  }
  return rest;
}

function localizedRow(row: Record<string, unknown>): Record<string, unknown> {
  const cached = localizedRows.get(row);
  if (cached) return cached;
  let result = localizedRecord(row);
  if (Array.isArray(row.toolMembers)) {
    let changed = false;
    const members = row.toolMembers.map((member) => {
      if (!isRecord(member)) return member;
      const next = localizedRecord(member);
      if (next !== member) changed = true;
      return next;
    });
    if (changed) result = { ...result, toolMembers: members };
  }
  localizedRows.set(row, result);
  return result;
}

/** `snapshot` with every noted tool row's text written in the UI language;
 *  the same object when no row carries a note. */
export function localizeRemoteOutputNotes(snapshot: SessionSnapshot): SessionSnapshot {
  const items = (snapshot as { items?: unknown } | null)?.items;
  if (!snapshot || !Array.isArray(items)) return snapshot;
  let changed = false;
  const next = items.map((item) => {
    if (!isRecord(item) || item.kind !== 'tool') return item;
    const row = localizedRow(item);
    if (row !== item) changed = true;
    return row;
  });
  return changed ? ({ ...snapshot, items: next } as SessionSnapshot) : snapshot;
}
