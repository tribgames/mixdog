// Composer support surfaces that are not the input itself: the project-context
// pill, the attachment budget model and prompt-history persistence.
// Composer.tsx holds the editor and its interaction handlers.
import { Folder } from 'lucide-react';

import type { DesktopProjectSummary } from '../shared/contract';
import {
  MAX_PROMPT_FILE_BASE64_TOTAL,
  MAX_PROMPT_FILE_BYTES,
  MAX_PROMPT_IMAGE_BASE64_TOTAL,
  OFFICE_MIME_TYPES,
} from '../shared/prompt-limits';
import { MIXDOG_PROJECT_PATHS_MIME } from './file-drag';
import { t } from './i18n';
import { OpenSelect } from './OpenSelect';
import { contentLocalStorage } from './remote-conversation-privacy';
import { asRecord, displayProject } from './text-format';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { formatPastedTextRef, pastedTextLineCount } from '../../../../src/tui/paste-text-policy.mjs';

/** Line count a paste chip reports, reused for attached text files. */
export const textLineCount: (text: string) => number = pastedTextLineCount;

/** Label, payload and prompt token of a folded paste chip for `text`. */
export function pastedTextFields(id: number, text: string): Pick<ComposerAttachment, 'name' | 'data' | 'token'> {
  return {
    name: `Pasted text · ${pastedTextLineCount(text)} lines`,
    data: text,
    token: formatPastedTextRef(id, text),
  };
}

export type ComposerAttachment = {
  id: number;
  name: string;
  /** `pdf` and `office` both travel as `file` prompt parts. */
  kind: 'image' | 'text' | 'pdf' | 'office';
  mimeType: string;
  data: string;
  token: string;
  source?: 'file' | 'paste';
  metadataText?: string;
  /** Chip-only attachments keep their bracket token out of the editor text;
   * the token is appended internally at send time so daemon expansion and
   * transcript folding still work. */
  chipOnly?: boolean;
  /** SHA-256 of `data`, worked out once when the chip enters a composer
   *  (`withContentDigest`); `of` is the data it was computed for, so a chip
   *  whose data changed is hashed again. In memory only, never persisted. */
  contentDigest?: { of: string; sha256: Promise<string> };
  /** A PDF's page count as its page tree states it (0 when it could not be
   *  read there); only drives the pre-send size notice. */
  pageCount?: number;
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
export const MAX_INLINE_IMAGE_BASE64_TOTAL = MAX_PROMPT_IMAGE_BASE64_TOTAL;
// PDFs and Office files attach as file parts, 20 MiB per file; the combined
// base64 size matches what the IPC prompt validator accepts.
export const MAX_PDF_FILE_BYTES = MAX_PROMPT_FILE_BYTES;
export const MAX_OFFICE_FILE_BYTES = MAX_PROMPT_FILE_BYTES;
export const MAX_INLINE_FILE_BASE64_TOTAL = MAX_PROMPT_FILE_BASE64_TOTAL;
export const MAX_IMAGE_FILE_BYTES = 12_000_000;
export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.docx,.pptx,.xlsx,.xlsm,.doc,.xls,.ppt,' +
  `${OFFICE_MIME_TYPES.join(',')},` +
  'text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql';
export const MAX_SUBMIT_TEXT_LENGTH = 950_000;
export const MAX_PERSISTED_PROMPT_HISTORY = 100;
export const COMPOSER_PROJECT_PATHS_MIME = MIXDOG_PROJECT_PATHS_MIME;
const PROMPT_HISTORY_STORAGE_PREFIX = 'mixdog.desktop.prompt-history.v1:';
const MAX_PERSISTED_PROMPT_HISTORY_CHARS = 2_000_000;
// One quiet line (user decision): no rotating tips, no syntax lecture.
export const COMPOSER_PLACEHOLDERS = ['Ask anything…'] as const;

const PROJECT_CONTEXT_LOCAL = '__mixdog_local__';

function promptHistoryStorageKey(scope: string) {
  return `${PROMPT_HISTORY_STORAGE_PREFIX}${encodeURIComponent(scope || 'new-task')}`;
}

function normalizedHistoryAttachment(value: unknown): ComposerAttachment | null {
  const entry = asRecord(value);
  if (entry?.kind !== 'text' || typeof entry.data !== 'string' || typeof entry.token !== 'string' || !entry.token)
    return null;
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
    const value = JSON.parse(contentLocalStorage().getItem(promptHistoryStorageKey(scope)) || '[]');
    if (!Array.isArray(value)) return [];
    return value
      .map(normalizedHistoryEntry)
      .filter((entry): entry is ComposerHistoryEntry => Boolean(entry))
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
  contentLocalStorage().setItem(promptHistoryStorageKey(scope), JSON.stringify(stored));
}

export function ProjectContextSelector({
  projects,
  activePath,
  activeLabel,
  disabled,
  onClear,
  onSelect,
}: {
  projects: DesktopProjectSummary[];
  activePath: string;
  activeLabel: string;
  disabled: boolean;
  onClear(): void;
  onSelect(path: string): void;
}) {
  const normalized = activePath.replace(/[\\/]+/g, '/').toLocaleLowerCase();
  const activeProject = projects.find(
    (project) => project.path.replace(/[\\/]+/g, '/').toLocaleLowerCase() === normalized
  );
  const fallbackActiveLabel = activePath ? activeLabel.trim() || displayProject(activePath).name || t('Project') : '';
  const options = [
    { value: PROJECT_CONTEXT_LOCAL, label: t('No project') },
    ...(activePath && !activeProject ? [{ value: activePath, label: fallbackActiveLabel }] : []),
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || displayProject(project.path).name || t('Project'),
    })),
  ];
  const value = activeProject?.path || activePath || PROJECT_CONTEXT_LOCAL;
  return (
    <div className="composer-project-context">
      <Folder size={14} />
      <OpenSelect
        className="context-pill-select project-context-select"
        ariaLabel={t('Project context')}
        tooltip={t('Select project')}
        value={value}
        displayValue={activeProject ? activeLabel || t('Project') : fallbackActiveLabel || t('Project')}
        disabled={disabled}
        options={options}
        onChange={(next) => {
          if (next === PROJECT_CONTEXT_LOCAL) {
            if (activePath) onClear();
          } else if (next !== activeProject?.path) onSelect(next);
        }}
      />
    </div>
  );
}
