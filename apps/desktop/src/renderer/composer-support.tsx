// Composer support surfaces that are not the input itself: the project-context
// pill, the attachment budget model, prompt-history persistence, and the
// queued-follow-up list. Extracted from Composer.tsx so that file holds the
// editor and its interaction handlers.
import { Folder, X } from "lucide-react";

import type { DesktopProjectSummary } from "../shared/contract";
import { MIXDOG_PROJECT_PATHS_MIME } from "./file-drag";
import { MxIcon } from "./MxIcon";
import { OpenSelect } from "./OpenSelect";
import { asRecord, displayProject, queueText } from "./text-format";

export type ComposerAttachment = {
  id: number;
  name: string;
  kind: 'image' | 'text' | 'pdf';
  mimeType: string;
  data: string;
  token: string;
  source?: 'file' | 'paste';
  metadataText?: string;
};

export type ComposerHistoryEntry = {
  text: string;
  /** Text payloads are safe to retain under the bounded history budget.
   * Binary image/PDF data is deliberately never persisted. */
  attachments?: ComposerAttachment[];
};

export const MAX_COMPOSER_ATTACHMENTS = 8;
export const MAX_INLINE_FILE_BYTES = 750_000;
export const MAX_INLINE_TEXT_TOTAL = 850_000;
export const MAX_INLINE_IMAGE_BASE64_TOTAL = 30_000_000;
// PDFs attach as provider document blocks, 20 MiB per file.
export const MAX_PDF_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_SUBMIT_TEXT_LENGTH = 950_000;
export const MAX_PERSISTED_PROMPT_HISTORY = 100;
export const COMPOSER_PROJECT_PATHS_MIME = MIXDOG_PROJECT_PATHS_MIME;
const PROMPT_HISTORY_STORAGE_PREFIX = 'mixdog.desktop.prompt-history.v1:';
const MAX_PERSISTED_PROMPT_HISTORY_CHARS = 2_000_000;
// One quiet line (user decision): no rotating tips, no syntax lecture.
export const COMPOSER_PLACEHOLDERS = ['Ask anything…'] as const;

export const PROJECT_CONTEXT_LOCAL = "__mixdog_local__";
export const PROJECT_CONTEXT_OPEN = "__mixdog_open__";

export function promptHistoryStorageKey(scope: string) {
  return `${PROMPT_HISTORY_STORAGE_PREFIX}${encodeURIComponent(scope || 'new-task')}`;
}

function normalizedHistoryAttachment(value: unknown): ComposerAttachment | null {
  const entry = asRecord(value);
  if (!entry || entry.kind !== 'text' || typeof entry.data !== 'string' ||
    typeof entry.token !== 'string' || !entry.token) return null;
  return {
    id: Number(entry.id) || 0,
    name: String(entry.name || 'Pasted text'),
    kind: 'text',
    mimeType: String(entry.mimeType || 'text/plain'),
    data: entry.data,
    token: entry.token,
    source: entry.source === 'file' ? 'file' : 'paste',
  };
}

function normalizedHistoryEntry(value: unknown): ComposerHistoryEntry | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { text } : null;
  }
  const entry = asRecord(value);
  const text = String(entry?.text || '').trim();
  if (!text) return null;
  const attachments = Array.isArray(entry?.attachments)
    ? entry.attachments.map(normalizedHistoryAttachment).filter((item): item is ComposerAttachment => Boolean(item))
    : [];
  return { text, ...(attachments.length ? { attachments } : {}) };
}

export function readPromptHistory(scope: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(promptHistoryStorageKey(scope)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.map(normalizedHistoryEntry).filter((entry): entry is ComposerHistoryEntry => Boolean(entry))
      .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  } catch {
    return [];
  }
}

export function writePromptHistory(scope: string, entries: ComposerHistoryEntry[]) {
  const stored: ComposerHistoryEntry[] = [];
  let used = 2;
  for (const raw of entries.slice(0, MAX_PERSISTED_PROMPT_HISTORY)) {
    const entry = normalizedHistoryEntry(raw);
    if (!entry) continue;
    const full = JSON.stringify(entry);
    const textOnly = JSON.stringify({ text: entry.text });
    const value = used + full.length + 1 <= MAX_PERSISTED_PROMPT_HISTORY_CHARS ? full : textOnly;
    if (used + value.length + 1 > MAX_PERSISTED_PROMPT_HISTORY_CHARS) break;
    stored.push(JSON.parse(value));
    used += value.length + 1;
  }
  window.localStorage.setItem(promptHistoryStorageKey(scope), JSON.stringify(stored));
}

export function queuedFollowupPreview(entry: unknown) {
  return queueText(entry).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "[Attachment]";
}

export function queuedImageCount(entry: unknown) {
  const record = asRecord(entry);
  const images = Array.isArray(record?.images)
    ? record.images.filter(Boolean).length
    : 0;
  if (images > 0) return images;
  const pastedImages = asRecord(record?.pastedImages);
  return pastedImages ? Object.values(pastedImages).filter(Boolean).length : 0;
}

// Text sniffing: accept any file whose first 4 KB has no NUL byte and a low
// control-character ratio, instead of trusting an extension whitelist (.env,
// .ini, extension-less logs, …).
export async function fileLooksLikeText(file: File): Promise<boolean> {
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

export function ProjectContextSelector({ projects, activePath, activeLabel, disabled, onClear, onSelect, onChoose }: {
  projects: DesktopProjectSummary[];
  activePath: string;
  activeLabel: string;
  disabled: boolean;
  onClear(): void;
  onSelect(path: string): void;
  onChoose(): void;
}) {
  const normalized = activePath.replace(/[\\/]+/g, "/").toLocaleLowerCase();
  const activeProject = projects.find((project) =>
    project.path.replace(/[\\/]+/g, "/").toLocaleLowerCase() === normalized);
  const options = [
    { value: PROJECT_CONTEXT_LOCAL, label: "No project" },
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || displayProject(project.path).name || "Project",
    })),
    { value: PROJECT_CONTEXT_OPEN, label: "Open folder…" },
  ];
  const value = activeProject?.path || PROJECT_CONTEXT_LOCAL;
  return <div className="composer-project-context">
    <Folder size={14} />
    <OpenSelect className="context-pill-select project-context-select" ariaLabel="Project context"
      value={value} displayValue={activeProject ? activeLabel || "Project" : "Project"} disabled={disabled}
      options={options} onChange={(next) => {
        if (next === PROJECT_CONTEXT_OPEN) onChoose();
        else if (next === PROJECT_CONTEXT_LOCAL) {
          if (activeProject) onClear();
        } else if (next !== activeProject?.path) onSelect(next);
      }} />
  </div>;
}

export function QueueList({ queued, restoring, onEdit, onRemove }: {
  queued?: unknown[];
  restoring: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!Array.isArray(queued) || queued.length === 0) return null;
  const label = `${queued.length} queued follow-up${queued.length === 1 ? "" : "s"}`;
  return (
    <section className="queue-list" aria-label={label}>
      <div className="queue-items" role="list">
        {queued.map((entry, index) => {
          const id = String(asRecord(entry)?.id || "");
          const text = queuedFollowupPreview(entry);
          const imageCount = queuedImageCount(entry);
          return <div className="queue-item" role="listitem" key={id || index}>
            <span className="queue-item-text" title={text}>{text}</span>
            {imageCount > 0 && <span className="queue-item-attachments"
              aria-label={`${imageCount} attached image${imageCount === 1 ? "" : "s"}`}>
              <MxIcon name="photo" size={14} />
              <span>{imageCount}</span>
            </span>}
            <button type="button" className="queue-edit" disabled={restoring || !id}
              onClick={() => onEdit(id)} aria-label={`Edit queued follow-up: ${text}`}>
              {restoring ? "Editing…" : "Edit"}
            </button>
            <button type="button" className="queue-remove" disabled={restoring || !id}
              onClick={() => onRemove(id)} aria-label={`Remove queued follow-up: ${text}`}
              data-tooltip="Remove">
              <X size={14} />
            </button>
          </div>;
        })}
      </div>
    </section>
  );
}
