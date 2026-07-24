import React, { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { MxIcon } from './MxIcon';

// Composer-parity attachments for automation editors (schedules/webhooks).
// Persisted with the automation row (jsonb) and replayed on every fire as
// composer-style content parts. Mirrors the runtime's
// automation-attachments.mjs shape/limits.
export type AutomationAttachment = {
  kind: 'image' | 'text' | 'pdf';
  name: string;
  mimeType: string;
  data: string; // base64 for image/pdf, plain text for text files
};

export const MAX_AUTOMATION_ATTACHMENTS = 8;
const MAX_BINARY_TOTAL = 8_000_000;
const MAX_TEXT_TOTAL = 200_000;

export function attachmentsFromRecords(value: unknown): AutomationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    const kind = String(row?.kind || '');
    const data = typeof row?.data === 'string' ? row.data : '';
    if (!data || (kind !== 'image' && kind !== 'text' && kind !== 'pdf')) return [];
    return [{
      kind: kind as AutomationAttachment['kind'],
      name: String(row?.name || 'attachment'),
      mimeType: String(row?.mimeType || ''),
      data,
    }];
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

async function fileLooksLikeText(file: File): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (bytes.length === 0) return true;
    let control = 0;
    for (const byte of bytes) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / bytes.length <= 0.3;
  } catch {
    return false;
  }
}

/** Read picked files into attachments, enforcing count/size caps against `existing`. */
export async function readAutomationFiles(files: FileList | File[], existing: AutomationAttachment[]): Promise<{
  attachments: AutomationAttachment[];
  error: string;
}> {
  const next = [...existing];
  let binaryTotal = existing.reduce((sum, item) => sum + (item.kind === 'text' ? 0 : item.data.length), 0);
  let textTotal = existing.reduce((sum, item) => sum + (item.kind === 'text' ? item.data.length : 0), 0);
  for (const file of Array.from(files)) {
    if (next.length >= MAX_AUTOMATION_ATTACHMENTS) {
      return { attachments: next, error: `Attach up to ${MAX_AUTOMATION_ATTACHMENTS} items.` };
    }
    if (file.type.startsWith('image/')) {
      const data = await fileBase64(file);
      binaryTotal += data.length;
      if (binaryTotal > MAX_BINARY_TOTAL) return { attachments: next, error: 'Image/PDF attachments are too large together (8 MB max).' };
      next.push({ kind: 'image', name: file.name || 'image', mimeType: file.type || 'image/png', data });
      continue;
    }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
      const data = await fileBase64(file);
      binaryTotal += data.length;
      if (binaryTotal > MAX_BINARY_TOTAL) return { attachments: next, error: 'Image/PDF attachments are too large together (8 MB max).' };
      next.push({ kind: 'pdf', name: file.name || 'document.pdf', mimeType: 'application/pdf', data });
      continue;
    }
    if (await fileLooksLikeText(file)) {
      const data = await file.text();
      textTotal += data.length;
      if (textTotal > MAX_TEXT_TOTAL) return { attachments: next, error: 'Text attachments are too large together (200 KB max).' };
      next.push({ kind: 'text', name: file.name || 'file.txt', mimeType: file.type || 'text/plain', data });
      continue;
    }
    return { attachments: next, error: `"${file.name}" is not a supported attachment (image, PDF, or text).` };
  }
  return { attachments: next, error: '' };
}

// Same accept surface as the chat composer's attach button.
const ATTACH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql';

/** Composer-style "+" attach tool + hidden input; reports the merged list via onChange. */
export function AutomationAttachButton({ attachments, disabled, ariaLabel, onChange, onError }: {
  attachments: AutomationAttachment[];
  disabled: boolean;
  ariaLabel: string;
  onChange(next: AutomationAttachment[]): void;
  onError(message: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="composer-tool" disabled={disabled}
      aria-label={ariaLabel} data-tooltip="Attach images, PDFs, or text files" data-tooltip-side="top"
      onClick={() => input.current?.click()}>
      <MxIcon name="plus" size={16} />
    </button>
    <input ref={input} type="file" multiple hidden aria-hidden="true" tabIndex={-1} accept={ATTACH_ACCEPT}
      onChange={(event) => {
        const files = event.currentTarget.files;
        event.currentTarget.value = '';
        if (!files || files.length === 0) return;
        void readAutomationFiles(files, attachments).then(({ attachments: next, error }) => {
          onError(error);
          onChange(next);
        });
      }} />
  </>;
}

/** Composer-style chips row with per-item remove. */
export function AutomationAttachmentChips({ attachments, disabled, onChange }: {
  attachments: AutomationAttachment[];
  disabled: boolean;
  onChange(next: AutomationAttachment[]): void;
}) {
  if (attachments.length === 0) return null;
  return <div className="composer-attachments schedules-attachments" aria-label="Attachments">
    {attachments.map((attachment, index) => <div className={`attachment-chip ${attachment.kind}`} key={`${attachment.name}-${index}`}>
      {attachment.kind === 'image'
        ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
        : <span aria-hidden="true"><Paperclip size={14} /></span>}
      <span data-tooltip={attachment.name}>{attachment.name}</span>
      <button type="button" aria-label={`Remove ${attachment.name}`} disabled={disabled}
        onClick={() => onChange(attachments.filter((_, itemIndex) => itemIndex !== index))}>×</button>
    </div>)}
  </div>;
}
