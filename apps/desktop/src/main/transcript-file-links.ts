// Local file links an assistant reply names, read on the host from the
// session's own transcript. This is the provenance behind every file OUTSIDE
// the registered projects that a paired device may open or download: only
// settled `assistant` rows the runtime produced count, plus the preview images
// of the session's pending tool approval (the approval card shows them). User
// prompts and tool output never count, whatever paths they print.
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

/** The session's settled assistant row with this id: never a prompt, a tool
 *  row or a reply still streaming. */
export function settledAssistantItem(snapshot: SessionSnapshot, itemId: string): DesktopTranscriptItem | null {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  return (
    items.find(
      (item) =>
        item?.kind === 'assistant' &&
        item.streaming !== true &&
        typeof item.text === 'string' &&
        item.id != null &&
        String(item.id) === itemId
    ) ?? null
  );
}

/** The absolute path `href` names when the row links it, else null. */
export function assistantItemLink(item: DesktopTranscriptItem, href: string, cwd: string): string | null {
  const requestedPath = linkPath(href);
  const requested = requestedPath ? resolveLinkedPath(requestedPath, cwd) : null;
  if (!requested) return null;
  const linked = assistantLinkTargets(String(item.text)).some((path) => {
    const target = resolveLinkedPath(path, cwd);
    return target !== null && sameGrantedPath(target, requested);
  });
  return linked ? requested : null;
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

/** Every absolute host path the session's settled assistant rows link, plus
 *  its pending approval's preview images. */
export function sessionLinkedPaths(snapshot: SessionSnapshot, cwd: string): string[] {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const paths = new Set<string>(approvalPreviewPaths(snapshot));
  for (const item of items) {
    if (item?.kind !== 'assistant' || item.streaming === true || typeof item.text !== 'string') continue;
    for (const path of assistantLinkTargets(item.text)) {
      const target = resolveLinkedPath(path, cwd);
      if (target) paths.add(target);
    }
  }
  return [...paths];
}

const MEDIA_TOOL = /^(?:mcp__[^_]+(?:_[^_]+)*__)?media$/i;

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

/** Gallery assets the session's own successful `media` tool calls generated
 *  — what its transcript shows as generated output. Prompts, replies and
 *  other tools' output name none. */
export function sessionGeneratedAssetIds(snapshot: SessionSnapshot): Set<string> {
  const ids = new Set<string>();
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const tools = items.flatMap((item) =>
    item?.aggregate === true && Array.isArray(item.toolMembers) ? (item.toolMembers as DesktopTranscriptItem[]) : [item]
  );
  for (const item of tools) {
    if (!item || item.kind === 'user' || item.kind === 'assistant' || item.isError === true) continue;
    if (!MEDIA_TOOL.test(String(item.name ?? ''))) continue;
    for (const record of toolResultRecords(item.result ?? item.rawResult)) {
      if (record.ok === true && typeof record.assetId === 'string' && record.assetId && record.status !== 'failed') {
        ids.add(record.assetId);
      }
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
        paths: sessionLinkedPaths(
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
