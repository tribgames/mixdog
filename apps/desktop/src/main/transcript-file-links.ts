// Host paths a conversation names, decoded on the host the way the renderer
// decodes them (a link's href as MarkdownLink decodes it: markdown-url.ts,
// shared/local-files.ts; a path relative to the session's folder), and the
// attachments a session's rows carry. A paired device's download of such a
// path (file-downloads.ts) is then opened like the desktop opens it.
import { isAbsolute, resolve } from 'node:path';

import type { SessionSnapshot } from '../shared/contract';
import { parseLocalFileLocation } from '../shared/local-files';
import { isLocalMarkdownLink, localMarkdownPath } from '../renderer/markdown-url';

const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>]+$/u;
const NETWORK_PATH = /^[\\/]{2}/;

/** One href decoded the way MarkdownLink decodes a local href, without its
 *  `:line`/`#L` location; null for web links and empty targets. */
function linkPath(raw: string | undefined): string | null {
  const text = String(raw ?? '')
    .trim()
    .replace(TRAILING_PUNCTUATION, '');
  if (!text || !isLocalMarkdownLink(text)) return null;
  const path = localMarkdownPath(parseLocalFileLocation(text).path);
  return path && !path.includes('\0') ? path : null;
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
