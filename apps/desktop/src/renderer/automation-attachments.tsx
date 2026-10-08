import { Paperclip, X } from 'lucide-react';
import { useRef } from 'react';
import {
  fileExtension,
  hasPdfHeader,
  IMAGE_MIME_BY_EXTENSION,
  legacyOfficeReplacement,
  officeMimeForName,
  SUPPORTED_IMAGE_TYPES,
} from './composer-attachments';
import {
  ATTACHMENT_ACCEPT,
  MAX_IMAGE_FILE_BYTES,
  MAX_OFFICE_FILE_BYTES,
  MAX_PDF_FILE_BYTES,
} from './composer-support';
import { fileLooksLikeText } from './file-content';
import { canonicalPromptFileMimeType, MAX_PROMPT_FILE_BASE64_TOTAL, PDF_MIME_TYPE } from '../shared/prompt-limits';
import { t } from './i18n';
import { MxIcon } from './MxIcon';

// Composer-parity attachments for automation editors (schedules/webhooks).
// Persisted with the automation row (jsonb) and replayed on every fire as
// composer-style content parts. Mirrors the runtime's
// automation-attachments.mjs shape/limits.
export type AutomationAttachment = {
  kind: 'image' | 'text' | 'pdf' | 'office';
  name: string;
  mimeType: string;
  data: string; // base64 for image/pdf, plain text for text files
};

const MAX_AUTOMATION_ATTACHMENTS = 8;
const MAX_TEXT_TOTAL = 200_000;
const attachmentDomKeys = new WeakMap<AutomationAttachment, string>();
let attachmentDomKeySequence = 0;

function attachmentDomKey(attachment: AutomationAttachment): string {
  const existing = attachmentDomKeys.get(attachment);
  if (existing) return existing;
  const key = `automation-attachment-${++attachmentDomKeySequence}`;
  attachmentDomKeys.set(attachment, key);
  return key;
}

export function attachmentsFromRecords(value: unknown): AutomationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const kind = String(row?.kind || '');
    const data = typeof row?.data === 'string' ? row.data : '';
    // Older rows stored Office files as kind 'pdf' with an OOXML MIME type;
    // they keep loading unchanged.
    if (!data || (kind !== 'image' && kind !== 'text' && kind !== 'pdf' && kind !== 'office')) return [];
    return [
      {
        kind: kind as AutomationAttachment['kind'],
        name: String(row?.name || 'attachment'),
        mimeType: String(row?.mimeType || ''),
        data,
      },
    ];
  });
}

async function fileBase64(file: File): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return url.slice(url.indexOf(',') + 1);
}

/** Read picked files into attachments, enforcing count/size caps against `existing`. */
export async function readAutomationFiles(
  files: FileList | File[],
  existing: AutomationAttachment[]
): Promise<{
  attachments: AutomationAttachment[];
  error: string;
}> {
  const next = [...existing];
  let binaryTotal = existing.reduce((sum, item) => sum + (item.kind === 'text' ? 0 : item.data.length), 0);
  let textTotal = existing.reduce((sum, item) => sum + (item.kind === 'text' ? item.data.length : 0), 0);
  for (const file of Array.from(files)) {
    if (next.length >= MAX_AUTOMATION_ATTACHMENTS) {
      return { attachments: next, error: t('Attach up to {{count}} items.', { count: MAX_AUTOMATION_ATTACHMENTS }) };
    }
    const name = file.name || 'attachment';
    if (file.size === 0) return { attachments: next, error: t('{{name}}: the file is empty.', { name }) };
    const legacyFormat = legacyOfficeReplacement(name);
    if (legacyFormat) {
      return {
        attachments: next,
        error: t("{{name}}: legacy Office files can't be attached. Save it as {{format}} and try again.", {
          name,
          format: legacyFormat,
        }),
      };
    }
    const mimeKind = (file.type || '').split(';', 1)[0].trim().toLowerCase();
    const isPdf = mimeKind === PDF_MIME_TYPE || /\.pdf$/i.test(name);
    const officeMime = officeMimeForName(name) || canonicalPromptFileMimeType(mimeKind);
    const extensionImage = IMAGE_MIME_BY_EXTENSION[fileExtension(name)];
    const imageType =
      extensionImage && (!mimeKind || mimeKind === 'application/octet-stream') ? extensionImage : mimeKind;
    if (imageType.startsWith('image/') || isPdf || officeMime) {
      let kind: AutomationAttachment['kind'] = 'image';
      let mimeType = imageType;
      if (imageType.startsWith('image/')) {
        if (!SUPPORTED_IMAGE_TYPES.test(imageType) || file.size > MAX_IMAGE_FILE_BYTES) {
          return { attachments: next, error: t('{{name}}: use PNG, JPEG, GIF, or WebP under 12 MB.', { name }) };
        }
      } else if (isPdf) {
        if (file.size > MAX_PDF_FILE_BYTES) {
          return { attachments: next, error: t('{{name}}: PDFs must be under 20 MB.', { name }) };
        }
        if (!(await hasPdfHeader(file))) {
          return { attachments: next, error: t('{{name}}: this file is not a valid PDF.', { name }) };
        }
        kind = 'pdf';
        mimeType = PDF_MIME_TYPE;
      } else {
        if (file.size > MAX_OFFICE_FILE_BYTES) {
          return { attachments: next, error: t('{{name}}: Office files must be under 20 MB.', { name }) };
        }
        kind = 'office';
        mimeType = officeMime;
      }
      const data = await fileBase64(file);
      binaryTotal += data.length;
      if (binaryTotal > MAX_PROMPT_FILE_BASE64_TOTAL) {
        const max = Math.floor(MAX_PROMPT_FILE_BASE64_TOTAL / 1_000_000);
        return {
          attachments: next,
          error: t('Image, PDF and Office attachments are too large together ({{max}} MB max).', { max }),
        };
      }
      next.push({ kind, name, mimeType, data });
      continue;
    }
    if (await fileLooksLikeText(file)) {
      const data = await file.text();
      textTotal += data.length;
      if (textTotal > MAX_TEXT_TOTAL) {
        return { attachments: next, error: t('Text attachments are too large together (200 KB max).') };
      }
      const textMime = mimeKind && mimeKind !== 'application/octet-stream' ? mimeKind : 'text/plain';
      next.push({ kind: 'text', name: file.name || 'file.txt', mimeType: textMime, data });
      continue;
    }
    return {
      attachments: next,
      error: t('"{{name}}" is not a supported attachment (image, PDF, Office file, or text).', { name: file.name }),
    };
  }
  return { attachments: next, error: '' };
}

/** Composer-style "+" attach tool + hidden input; reports the merged list via onChange. */
export function AutomationAttachButton({
  attachments,
  disabled,
  ariaLabel,
  onChange,
  onError,
}: {
  attachments: AutomationAttachment[];
  disabled: boolean;
  ariaLabel: string;
  onChange(next: AutomationAttachment[]): void;
  onError(message: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="composer-tool"
        disabled={disabled}
        aria-label={ariaLabel}
        data-tooltip={t('Attach images, PDFs, Office files, or text files')}
        data-tooltip-side="top"
        onClick={() => input.current?.click()}
      >
        <MxIcon name="plus" size={16} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        accept={ATTACHMENT_ACCEPT}
        onChange={(event) => {
          const files = event.currentTarget.files;
          event.currentTarget.value = '';
          if (!files || files.length === 0) return;
          void readAutomationFiles(files, attachments).then(({ attachments: next, error }) => {
            onError(error);
            onChange(next);
          });
        }}
      />
    </>
  );
}

/** Composer-style chips row with per-item remove. */
export function AutomationAttachmentChips({
  attachments,
  disabled,
  onChange,
}: {
  attachments: AutomationAttachment[];
  disabled: boolean;
  onChange(next: AutomationAttachment[]): void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="composer-attachments schedules-attachments" aria-label={t('Attachments')}>
      {attachments.map((attachment, index) => (
        <div className={`attachment-chip ${attachment.kind}`} key={attachmentDomKey(attachment)}>
          {attachment.kind === 'image' ? (
            <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
          ) : (
            <span aria-hidden="true">
              <Paperclip size={14} />
            </span>
          )}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button
            type="button"
            className="attachment-remove"
            aria-label={t('Remove {{name}}', { name: attachment.name })}
            data-tooltip={t('Remove')}
            disabled={disabled}
            onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
