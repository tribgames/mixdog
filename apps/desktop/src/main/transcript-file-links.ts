// Local file links an assistant reply names, read on the host from the
// session's own transcript. This is the provenance behind every file OUTSIDE
// the registered projects that a paired device may open or download: only
// settled `assistant` rows the runtime produced count, plus the preview images
// of the session's pending tool approval (the approval card shows them), and
// — sessionReferencedPaths — the paths in the output of the session's
// completed tool rows. User prompts and tool arguments never count, whatever
// paths they print.
//
// The grammar is the renderer's link surface (renderer/markdown-plugins.ts)
// widened, never narrowed: markdown link and reference targets, autolinks,
// inline code and path-like prose tokens, outside fenced code blocks. Every
// candidate is decoded the way MarkdownLink decodes an href (markdown-url.ts,
// shared/local-files.ts) and resolved against the session's folder.
import { isAbsolute, resolve } from 'node:path';

import type { DesktopSessionSummary, DesktopTranscriptItem, SessionSnapshot } from '../shared/contract';
import { parseLocalFileLocation } from '../shared/local-files';
import { isLocalMarkdownLink, localMarkdownPath } from '../renderer/markdown-url';
import { sameGrantedPath } from './selected-file-grants';

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_TARGET = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g;
const REFERENCE_TARGET = /^ {0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]+)>|(\S+))/gm;
const AUTOLINK = /<((?:file:|[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^<>\n]*)>/g;
const INLINE_CODE = /(`+)([^`\n]+?)\1/g;
const SEGMENT = '[\\p{L}\\p{N}_.@+~-]+';
// A token starts at a word boundary, so the path part of a web URL is no path.
const PROSE_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}_.@+~:\\\\/-])` +
    `(?:file:\\/\\/(?:localhost)?\\/?(?:[A-Za-z]:[\\\\/])?|[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])?` +
    `(?:${SEGMENT}[\\\\/])+(?:${SEGMENT})?`,
  'gu'
);
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>]+$/u;
const NETWORK_PATH = /^[\\/]{2}/;

/** The reply without its fenced code blocks: the renderer links nothing there. */
function withoutFencedCode(text: string): string {
  const kept: string[] = [];
  let fence = '';
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1] ?? '';
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** One candidate decoded the way MarkdownLink decodes a local href, without
 *  its `:line`/`#L` location; null for web links and empty targets. */
function linkPath(raw: string | undefined): string | null {
  const text = String(raw ?? '')
    .trim()
    .replace(TRAILING_PUNCTUATION, '');
  if (!text || !isLocalMarkdownLink(text)) return null;
  const path = localMarkdownPath(parseLocalFileLocation(text).path);
  return path && !path.includes('\0') ? path : null;
}

/** Every local link target an assistant reply writes, decoded (`/`
 *  separators) and still relative where the reply wrote it relative. */
export function assistantLinkTargets(text: string): string[] {
  const prose = withoutFencedCode(text);
  const found = new Set<string>();
  const add = (raw: string | undefined): void => {
    const path = linkPath(raw);
    if (path) found.add(path);
  };
  for (const match of prose.matchAll(MARKDOWN_TARGET)) add(match[1] ?? match[2]);
  for (const match of prose.matchAll(REFERENCE_TARGET)) add(match[1] ?? match[2]);
  for (const match of prose.matchAll(AUTOLINK)) add(match[1]);
  for (const match of prose.matchAll(INLINE_CODE)) add(match[2]);
  for (const match of prose.matchAll(PROSE_PATH)) add(match[0]);
  return [...found];
}

/** The absolute host path a decoded link names: absolute as written, or
 *  relative to the session's folder. Null for network (UNC) targets and for a
 *  relative link when the session's folder is unknown. */
export function resolveLinkedPath(path: string, cwd: string): string | null {
  if (NETWORK_PATH.test(path)) return null;
  if (isAbsolute(path)) return resolve(path);
  if (!cwd || !isAbsolute(cwd)) return null;
  return resolve(cwd, path);
}

/** The absolute host path a link's `href` names, decoded the way MarkdownLink
 *  decodes it (`:line`/`#L` dropped); null for web links and unresolvable
 *  targets. */
export function requestedLinkPath(href: string, cwd: string): string | null {
  const requestedPath = linkPath(href);
  return requestedPath ? resolveLinkedPath(requestedPath, cwd) : null;
}

/** Every absolute host path the session's settled assistant rows link. */
function assistantLinkedPaths(snapshot: SessionSnapshot, cwd: string): string[] {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const paths = new Set<string>();
  for (const item of items) {
    if (item?.kind !== 'assistant' || item.streaming === true || typeof item.text !== 'string') continue;
    for (const path of assistantLinkTargets(item.text)) {
      const target = resolveLinkedPath(path, cwd);
      if (target) paths.add(target);
    }
  }
  return [...paths];
}

/** The absolute path `href` names when a settled assistant reply of the
 *  session links it, else null. Prompts, tool rows and replies still
 *  streaming never count. The reply is not named by its row id: each surface
 *  numbers the rows it restored itself (a phone's window and the PC's
 *  projection give one reply different ids), so a row id cannot be checked
 *  against the host's copy. */
export function assistantLinkedPath(snapshot: SessionSnapshot, href: string, cwd: string): string | null {
  const requested = requestedLinkPath(href, cwd);
  if (!requested) return null;
  return assistantLinkedPaths(snapshot, cwd).some((path) => sameGrantedPath(path, requested)) ? requested : null;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Host paths the session's pending tool approval renders as preview images
 *  (the same fields ApprovalCard.tsx shows). */
function approvalPreviewPaths(snapshot: SessionSnapshot): string[] {
  const args = recordOf(recordOf(snapshot?.toolApproval)?.args);
  const preview = recordOf(args?.preview);
  const visualDiff = recordOf(preview?.visualDiff);
  return [
    ...(Array.isArray(preview?.images) ? preview.images : []),
    ...(Array.isArray(visualDiff?.images) ? visualDiff.images : []),
  ].flatMap((image) => {
    const path = recordOf(image)?.path;
    return typeof path === 'string' && isAbsolute(path) && !NETWORK_PATH.test(path) ? [resolve(path)] : [];
  });
}

/** Host paths of the files a task report returned (`routine.files`, written
 *  by the runtime after its own containment check, never by a model): the
 *  path links its row draws. */
function returnedFilePaths(snapshot: SessionSnapshot): string[] {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return items.flatMap((item) => {
    const routine = item?.kind === 'notice' ? recordOf(item.routine) : null;
    if (routine?.kind !== 'task' || !Array.isArray(routine.files)) return [];
    return routine.files.flatMap((file) => {
      const path = recordOf(file)?.path;
      return typeof path === 'string' && isAbsolute(path) && !NETWORK_PATH.test(path) ? [resolve(path)] : [];
    });
  });
}

/** Every absolute host path the session's settled assistant rows link, plus
 *  its pending approval's preview images and its task reports' returned files. */
export function sessionLinkedPaths(snapshot: SessionSnapshot, cwd: string): string[] {
  return [
    ...new Set([
      ...approvalPreviewPaths(snapshot),
      ...assistantLinkedPaths(snapshot, cwd),
      ...returnedFilePaths(snapshot),
    ]),
  ];
}

/** Most strings of one tool row scanned, and paths kept for one session. */
const MAX_TOOL_STRINGS = 400;
export const MAX_SESSION_PATHS = 4_000;
const WHOLE_PATH_MAX = 1_024;

/** Where a tool row keeps what the tool produced. Its arguments, input and
 *  subject are not among them: the model writes those, and a prompt can make
 *  it write any path there. */
const TOOL_OUTPUT_FIELDS = ['result', 'rawResult', 'output'] as const;

/** Every string a tool row's output shows: its result, raw result and output. */
function toolRowStrings(item: DesktopTranscriptItem): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (found.length >= MAX_TOOL_STRINGS || depth > 6 || value == null) return;
    if (typeof value === 'string') {
      found.push(value);
      // A JSON result keeps its structured fields (`output`, `path`, `file`).
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          /* prose */
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (typeof value === 'object') for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  for (const key of TOOL_OUTPUT_FIELDS) visit(item[key], 0);
  return found;
}

/** A tool row whose output is final: finished, not streaming or running. */
function completedToolRow(item: DesktopTranscriptItem): boolean {
  return item.streaming !== true && item.status !== 'running' && toolItemDone(item);
}

/** Host paths a tool row produced: link-shaped tokens in its output, and a
 *  string that is itself an absolute path (names with spaces included) as a
 *  structured output field such as `output`, `path` or `file`. */
function toolItemPaths(item: DesktopTranscriptItem, cwd: string): string[] {
  const paths = new Set<string>();
  for (const text of toolRowStrings(item)) {
    const whole = text.trim();
    if (whole && whole.length <= WHOLE_PATH_MAX && !/[\r\n\0]/.test(whole) && isAbsolute(whole)) {
      const target = resolveLinkedPath(whole, cwd);
      if (target) paths.add(target);
    }
    for (const path of assistantLinkTargets(text)) {
      const target = resolveLinkedPath(path, cwd);
      if (target) paths.add(target);
    }
  }
  return [...paths];
}

/** Everything the conversation shows or produced, as absolute host paths:
 *  what its settled replies link (sessionLinkedPaths) plus the paths in the
 *  output of its completed tool rows — results, raw results, shell/agent
 *  outputs, screenshots and temp outputs. Prompts, tool arguments and rows
 *  still streaming or running count for nothing. The host authorizes a
 *  remote request only against this set, per session. */
export function sessionReferencedPaths(snapshot: SessionSnapshot, cwd: string): string[] {
  const paths = new Set<string>(sessionLinkedPaths(snapshot, cwd));
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const rows = items.flatMap((item) =>
    item?.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as DesktopTranscriptItem[]) : [item]
  );
  for (const row of rows) {
    if (!row || row.kind === 'user' || row.kind === 'assistant' || !completedToolRow(row)) continue;
    for (const path of toolItemPaths(row, cwd)) {
      if (paths.size >= MAX_SESSION_PATHS) return [...paths];
      paths.add(path);
    }
  }
  return [...paths];
}

/** The referenced path `requested` names (absolute, or relative to `cwd`),
 *  else null: an exact match of the resolved path, never a prefix, so a
 *  traversal or sibling of a referenced path is refused. */
export function referencedPathFor(snapshot: SessionSnapshot, cwd: string, requested: string): string | null {
  const target = resolveLinkedPath(requested, cwd);
  if (!target || requested.includes('\0')) return null;
  return sessionReferencedPaths(snapshot, cwd).find((path) => sameGrantedPath(path, target)) ?? null;
}

export interface SessionAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file' | 'text';
  size: number;
}

const ATTACHMENT_ID = /^[a-f0-9]{64}$/;

/** The attachments the session's USER rows carry, by content hash: the
 *  message metadata's `attachments` and, for rows sent before that was
 *  recorded, the images' own `attachmentRef` / `imageRefs`; plus the files a
 *  task report or a member's room speech returned. Nothing else in a
 *  transcript names an attachment the host will serve. */
export function sessionAttachments(snapshot: SessionSnapshot): Map<string, SessionAttachment> {
  const found = new Map<string, SessionAttachment>();
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const add = (id: unknown, info: Partial<SessionAttachment>): void => {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id) || found.has(id)) return;
    found.set(id, {
      id,
      name: String(info.name || 'attachment').slice(0, 200),
      mimeType: String(info.mimeType || 'application/octet-stream').slice(0, 100),
      kind: info.kind ?? 'file',
      size: Number(info.size) || 0,
    });
  };
  for (const item of items) {
    // The runtime's own rows that return files a bot or agent produced: a task
    // report (`routine.kind: 'task'`) and a member's room speech.
    const returned =
      item?.kind === 'notice' &&
      ((item.routine as Record<string, unknown> | undefined)?.kind === 'task' ||
        (item.room as Record<string, unknown> | undefined)?.kind === 'speech');
    if (item?.kind !== 'user' && !returned) continue;
    for (const entry of Array.isArray(item.attachments) ? (item.attachments as Array<Record<string, unknown>>) : []) {
      add(entry?.id, entry as Partial<SessionAttachment>);
    }
    for (const image of Array.isArray(item.images) ? (item.images as Array<Record<string, unknown>>) : []) {
      add(image?.attachmentRef, {
        name: String(image?.name || 'image'),
        mimeType: String(image?.mimeType || 'image/png'),
        kind: 'image',
        size: Number(image?.bytes) || 0,
      });
    }
    for (const slot of Array.isArray(item.imageRefs) ? (item.imageRefs as Array<Record<string, unknown>>) : []) {
      add(slot?.ref, { name: 'image', mimeType: 'image/png', kind: 'image' });
    }
  }
  return found;
}

/** Mixdog's built-in media tool; an MCP server's `mcp__…__media` is not it. */
const MEDIA_TOOL = 'media';
const UNFINISHED_STATUSES = new Set(['running', 'failed', 'canceled', 'cancelled']);

/** The structured records a tool result carries (renderer
 *  transcript-artifacts.ts reads the same shapes); prose yields none. */
function toolResultRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === 'string') {
    try {
      return toolResultRecords(JSON.parse(value), depth + 1);
    } catch {
      return [];
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (record.isError === true || record.ok === false) return [];
  if (record.structuredContent) return toolResultRecords(record.structuredContent, depth + 1);
  if (Array.isArray(record.content)) {
    return record.content.flatMap((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? toolResultRecords((part as { text?: unknown }).text, depth + 1)
        : []
    );
  }
  return [record];
}

/** A finished tool row (renderer transcript-tool-core.ts `toolItemDone`). */
function toolItemDone(item: DesktopTranscriptItem): boolean {
  if (item.completedAt != null) return true;
  if (item.completedCount === undefined) return item.result != null || item.rawResult != null;
  return Number(item.completedCount) >= (Number(item.count) || 1);
}

/** Gallery assets the session's own built-in `media` tool calls generated:
 *  finished, error-free calls whose result reports a completed asset — the
 *  same rows the renderer's transcriptArtifacts shows as generated media.
 *  Prompts, replies, MCP tools and other tools' output name none. */
export function sessionGeneratedAssetIds(snapshot: SessionSnapshot): Set<string> {
  const ids = new Set<string>();
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const tools = items.flatMap((item) =>
    item?.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as DesktopTranscriptItem[]) : [item]
  );
  for (const item of tools) {
    if (!item || item.kind === 'user' || item.kind === 'assistant' || item.name !== MEDIA_TOOL) continue;
    if (!toolItemDone(item) || item.isError === true) continue;
    if ([item.errorCount, item.callErrorCount, item.exitErrorCount].some((count) => Number(count || 0) > 0)) continue;
    const value = typeof item.result === 'string' && item.result.trim() ? item.result : (item.result ?? item.rawResult);
    for (const record of toolResultRecords(value)) {
      if (UNFINISHED_STATUSES.has(String(record.status || ''))) continue;
      if (record.ok !== true || typeof record.assetId !== 'string' || !record.assetId) continue;
      if (!record.output && record.status !== 'done') continue;
      ids.add(record.assetId);
    }
  }
  return ids;
}

export interface TranscriptHost {
  listSessions(): Promise<DesktopSessionSummary[]>;
  readSessionTranscript?(sessionId: string): Promise<SessionSnapshot>;
}

/** Which of these conversations links a path. Each transcript is read at
 *  most once per instance, and only when a path actually needs provenance. */
export function createLinkProvenance(
  host: TranscriptHost,
  sessionIds: readonly string[]
): { sessionFor(absolutePath: string): Promise<string | null> } {
  let linked: Promise<Array<{ sessionId: string; paths: string[] }>> | null = null;
  const load = async (): Promise<Array<{ sessionId: string; paths: string[] }>> => {
    const read = host.readSessionTranscript?.bind(host);
    if (!read || !sessionIds.length) return [];
    const catalog = await host.listSessions().catch(() => []);
    return Promise.all(
      sessionIds.map(async (sessionId) => ({
        sessionId,
        // A conversation deleted meanwhile links nothing.
        paths: sessionReferencedPaths(
          await read(sessionId).catch(() => null),
          catalog.find((row) => row.id === sessionId)?.cwd ?? ''
        ),
      }))
    );
  };
  return {
    async sessionFor(absolutePath: string): Promise<string | null> {
      linked ??= load();
      const match = (await linked).find(({ paths }) => paths.some((path) => sameGrantedPath(path, absolutePath)));
      return match?.sessionId ?? null;
    },
  };
}
