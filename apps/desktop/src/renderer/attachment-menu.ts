// Right-click menu model shared by the sent-message chips and the composer's
// pending chips. Item selection is pure (`attachmentMenuItems`): an item is
// present only when the chip's data and the matching action both exist.
import type { ScmContextMenuItem } from './ScmContextMenu';
import type { ComposerAttachment } from './composer-support';
import { t } from './i18n';

export type AttachmentMenuSource =
  /** Image with bytes. */
  | { kind: 'image'; name: string; dataUrl?: string }
  /** Image known by name only. */
  | { kind: 'image-marker'; name: string }
  | { kind: 'pasted-text'; name: string; text?: string }
  | { kind: 'text-file'; name: string; text?: string }
  | { kind: 'pdf' | 'office'; name: string; dataUrl?: string };

/** The side effects a menu item can trigger; a missing one omits its item. */
export interface AttachmentMenuActions {
  /** In-app: stage the bytes and open them in Mixdog's editor pane. */
  openInApp?(dataUrl: string, name: string): Promise<void>;
  openImage?(dataUrl: string, name: string): Promise<void>;
  openFile?(dataUrl: string, name: string): Promise<void>;
  saveAs?(source: string, suggestedName: string): Promise<unknown>;
  copyImage?(dataUrl: string): Promise<void>;
  copyText?(text: string): Promise<void>;
  reportError?(error: unknown): void;
}

/** Menu source of a pending composer attachment. */
export function composerAttachmentSource(attachment: ComposerAttachment): AttachmentMenuSource {
  const { kind, name, data, mimeType } = attachment;
  if (kind === 'image') return { kind, name, dataUrl: `data:${mimeType};base64,${data}` };
  if (kind === 'text') {
    return attachment.source === 'paste'
      ? { kind: 'pasted-text', name, text: data }
      : { kind: 'text-file', name, text: data };
  }
  return { kind, name, dataUrl: `data:${mimeType};base64,${data}` };
}

function textDataUrl(text: string, mimeType = 'text/plain'): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:${mimeType};charset=utf-8;base64,${btoa(binary)}`;
}

export function attachmentMenuItems(
  source: AttachmentMenuSource,
  actions: AttachmentMenuActions
): ScmContextMenuItem[] {
  const items: ScmContextMenuItem[] = [];
  const add = (
    id: string,
    label: string,
    run: (() => Promise<unknown>) | null | undefined,
    report: (e: unknown) => void
  ) => {
    if (run) items.push({ id, label, onSelect: () => void run().catch(report) });
  };
  const fail = (error: unknown) => actions.reportError?.(error);
  const { name } = source;
  switch (source.kind) {
    case 'image': {
      const url = source.dataUrl;
      if (!url) break;
      add('open', t('Open'), actions.openInApp && (() => actions.openInApp!(url, name)), fail);
      add('open-default', t('Open with default app'), actions.openImage && (() => actions.openImage!(url, name)), fail);
      add('copy-image', t('Copy image'), actions.copyImage && (() => actions.copyImage!(url)), fail);
      add('save', t('Save image as…'), actions.saveAs && (() => actions.saveAs!(url, name)), fail);
      break;
    }
    case 'image-marker':
      add('copy-name', t('Copy name'), actions.copyText && (() => actions.copyText!(name)), fail);
      break;
    case 'pasted-text': {
      const text = source.text;
      if (text === undefined) break;
      add(
        'open',
        t('Open'),
        actions.openInApp && (() => actions.openInApp!(textDataUrl(text), 'pasted-text.txt')),
        fail
      );
      add('copy-text', t('Copy text'), actions.copyText && (() => actions.copyText!(text)), fail);
      add(
        'save',
        t('Save text as…'),
        actions.saveAs && (() => actions.saveAs!(textDataUrl(text), 'pasted-text.txt')),
        fail
      );
      break;
    }
    case 'text-file': {
      const text = source.text;
      if (text === undefined) break;
      add('open', t('Open'), actions.openInApp && (() => actions.openInApp!(textDataUrl(text), name)), fail);
      add(
        'open-default',
        t('Open with default app'),
        actions.openFile && (() => actions.openFile!(textDataUrl(text), name)),
        fail
      );
      add('copy-contents', t('Copy contents'), actions.copyText && (() => actions.copyText!(text)), fail);
      add('save', t('Save file as…'), actions.saveAs && (() => actions.saveAs!(textDataUrl(text), name)), fail);
      break;
    }
    case 'pdf':
    case 'office': {
      const url = source.dataUrl;
      if (!url) break;
      add('open', t('Open'), actions.openInApp && (() => actions.openInApp!(url, name)), fail);
      add('open-default', t('Open with default app'), actions.openFile && (() => actions.openFile!(url, name)), fail);
      add('save', t('Save file as…'), actions.saveAs && (() => actions.saveAs!(url, name)), fail);
      break;
    }
  }
  return items;
}

/** `[PDF #n: name]` / `[File #n: name]` tokens of a sent message. */
export interface FileMarkerChip {
  token: string;
  tokenKind: 'PDF' | 'File';
  name: string;
}

export function extractFileMarkers(text: string): { text: string; chips: FileMarkerChip[] } {
  const chips: FileMarkerChip[] = [];
  const source = String(text || '');
  const stripped = source.replace(/ ?(\[(PDF|File) #\d+: ([^\]\r\n]+)\]) ?/g, (_match, token, tokenKind, name) => {
    chips.push({ token, tokenKind, name });
    return ' ';
  });
  if (chips.length === 0) return { text: source, chips };
  const cleaned = stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, chips };
}

const OFFICE_EXTENSION = /\.(docx?|xlsx?|xlsm|pptx?)$/i;

/** Kind of a file chip when the sent message kept no data for it. */
export function fileChipKind(chip: FileMarkerChip): 'text-file' | 'pdf' | 'office' {
  if (chip.tokenKind === 'PDF' || /\.pdf$/i.test(chip.name)) return 'pdf';
  return OFFICE_EXTENSION.test(chip.name) ? 'office' : 'text-file';
}

export interface SentAttachmentData {
  kind: 'text' | 'pdf' | 'office';
  name: string;
  mimeType: string;
  /** Raw text for `text`, base64 for `pdf`/`office`. */
  data: string;
  /** True for a folded paste; false for an attached text file. */
  paste: boolean;
}

// A sent user item carries only `images` metadata; the bytes of pasted texts
// and files live here for the life of the window. Entries are keyed by the
// submission id (the sent item's `id`, unique per message) plus the prompt
// token, so a token reused by another message or session never collides and a
// chip never resolves without its own message's identity.
const SENT_ATTACHMENT_LIMIT = 64;
const sentAttachments = new Map<string, SentAttachmentData>();

function sentKey(submissionId: string | number | undefined, token: string): string | null {
  const id = submissionId === undefined || submissionId === null ? '' : String(submissionId);
  return id ? `${id}\0${token}` : null;
}

/** The non-image attachments of a submission as registry entries. */
export function sentAttachmentData(attachments: ComposerAttachment[]): Array<SentAttachmentData & { token: string }> {
  return attachments.flatMap((attachment) =>
    attachment.kind === 'image' || !attachment.token
      ? []
      : [
          {
            token: attachment.token,
            kind: attachment.kind,
            name: attachment.name,
            mimeType: attachment.mimeType,
            data: attachment.data,
            paste: attachment.source === 'paste',
          },
        ]
  );
}

/** Call only once the host accepted the submission. */
export function registerSentAttachments(
  submissionId: string,
  attachments: Array<SentAttachmentData & { token: string }>
) {
  for (const { token, ...data } of attachments) {
    const key = sentKey(submissionId, token);
    if (!key || !token) continue;
    sentAttachments.delete(key);
    sentAttachments.set(key, data);
    if (sentAttachments.size > SENT_ATTACHMENT_LIMIT) {
      sentAttachments.delete(sentAttachments.keys().next().value as string);
    }
  }
}

function sentAttachmentFor(submissionId: string | number | undefined, token: string): SentAttachmentData | undefined {
  const key = sentKey(submissionId, token);
  return key ? sentAttachments.get(key) : undefined;
}

/** Menu source of a sent file chip, wired to its message's stored data when present. */
export function sentFileSource(chip: FileMarkerChip, submissionId: string | number | undefined): AttachmentMenuSource {
  const stored = sentAttachmentFor(submissionId, chip.token);
  if (stored?.kind === 'text') return { kind: 'text-file', name: chip.name, text: stored.data };
  if (stored) return { kind: stored.kind, name: chip.name, dataUrl: `data:${stored.mimeType};base64,${stored.data}` };
  return { kind: fileChipKind(chip), name: chip.name };
}

/** Menu source of a sent folded-paste chip. */
export function sentPastedTextSource(
  token: string,
  name: string,
  submissionId: string | number | undefined
): AttachmentMenuSource {
  const stored = sentAttachmentFor(submissionId, token);
  return { kind: 'pasted-text', name, ...(stored ? { text: stored.data } : {}) };
}
