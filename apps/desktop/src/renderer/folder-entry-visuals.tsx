import { File } from "lucide-react";
import { useEffect, useState } from "react";

import type { DesktopFolderEntry } from "../shared/contract";
import { entryExt } from "./folder-pane-model";

const IMAGE_THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const UNIQUE_ICON_EXTS = new Set(["exe", "lnk", "ico", "url", "appref-ms"]);
export const FOLDER_ICON_CONCURRENCY = 6;
const MAX_FOLDER_ICON_CACHE_ENTRIES = 256;
const MAX_FOLDER_ICON_CACHE_CHARS = 24_000_000;
const folderIconCache = new Map<string, string>();
const folderIconPending = new Map<string, Promise<string>>();
const folderIconQueue: Array<{
  run: () => Promise<string>;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
}> = [];
let folderIconActive = 0;
let folderIconCacheChars = 0;

function runFolderIconQueue(): void {
  while (folderIconActive < FOLDER_ICON_CONCURRENCY && folderIconQueue.length) {
    const next = folderIconQueue.shift();
    if (!next) return;
    folderIconActive += 1;
    void Promise.resolve()
      .then(next.run)
      .then(next.resolve, next.reject)
      .finally(() => {
        folderIconActive -= 1;
        runFolderIconQueue();
      });
  }
}

function scheduleFolderIcon(run: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    folderIconQueue.push({ run, resolve, reject });
    runFolderIconQueue();
  });
}

function cachedFolderIcon(key: string): string | undefined {
  const value = folderIconCache.get(key);
  if (value === undefined) return undefined;
  folderIconCache.delete(key);
  folderIconCache.set(key, value);
  return value;
}

function cacheFolderIcon(key: string, value: string): void {
  if (!value) return;
  const previous = folderIconCache.get(key);
  if (previous !== undefined) {
    folderIconCacheChars -= previous.length;
    folderIconCache.delete(key);
  }
  folderIconCache.set(key, value);
  folderIconCacheChars += value.length;
  while (folderIconCache.size > MAX_FOLDER_ICON_CACHE_ENTRIES
    || folderIconCacheChars > MAX_FOLDER_ICON_CACHE_CHARS) {
    const oldest = folderIconCache.keys().next().value;
    if (typeof oldest !== "string") break;
    folderIconCacheChars -= folderIconCache.get(oldest)?.length ?? 0;
    folderIconCache.delete(oldest);
  }
}

export function folderIconRequest(path: string, entry: DesktopFolderEntry, edge = 32): {
  key: string;
  thumbnail: boolean;
  size: number;
} {
  const ext = entryExt(entry.name);
  if (IMAGE_THUMB_EXTS.has(ext) || edge > 36) {
    const bucket = edge > 56 ? 384 : 96;
    return {
      key: `thumb${bucket}:${path}:${entry.mtimeMs}`,
      thumbnail: true,
      size: bucket,
    };
  }
  return {
    key: !ext || UNIQUE_ICON_EXTS.has(ext) ? `path:${path}` : `ext:${ext}`,
    thumbnail: false,
    size: 96,
  };
}

function iconCacheKey(path: string, entry: DesktopFolderEntry, edge = 32): string {
  return folderIconRequest(path, entry, edge).key;
}

export function loadFolderEntryIcon(
  path: string,
  entry: DesktopFolderEntry,
  edge = 32,
): Promise<string> {
  const request = folderIconRequest(path, entry, edge);
  const key = request.key;
  const cached = cachedFolderIcon(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let pending = folderIconPending.get(key);
  if (!pending) {
    pending = scheduleFolderIcon(() => Promise.resolve(
      window.mixdogDesktop?.folderEntryIcon?.(path, request.thumbnail, request.size) ?? "",
    ))
      .catch(() => "")
      .then((data) => {
        cacheFolderIcon(key, data);
        return data || "";
      })
      .finally(() => folderIconPending.delete(key));
    folderIconPending.set(key, pending);
  }
  return pending;
}

export function FolderGlyph({ size }: { size: number }) {
  return <svg className="folder-entry-icon" width={size} height={size} viewBox="0 0 32 32"
    aria-hidden="true">
    <path d="M3 7.5C3 6.1 4.1 5 5.5 5h7.2l3 3H26.5C27.9 8 29 9.1 29 10.5v2H3v-5Z"
      fill="#e8b64c" />
    <path d="M3 11.5h26v12.9c0 1.4-1.1 2.6-2.5 2.6h-21A2.55 2.55 0 0 1 3 24.4V11.5Z"
      fill="#f7d372" />
  </svg>;
}

export function EntryIcon({ path, entry, size }: {
  path: string;
  entry: DesktopFolderEntry;
  size: number;
}) {
  if (entry.dir) return <FolderGlyph size={size} />;
  return <FileEntryIcon path={path} entry={entry} size={size} />;
}

function FileEntryIcon({ path, entry, size }: {
  path: string;
  entry: DesktopFolderEntry;
  size: number;
}) {
  const key = iconCacheKey(path, entry, size);
  const [icon, setIcon] = useState(() => cachedFolderIcon(key) ?? "");
  useEffect(() => {
    const cached = cachedFolderIcon(key);
    if (cached !== undefined) {
      setIcon(cached);
      return undefined;
    }
    let live = true;
    setIcon("");
    void loadFolderEntryIcon(path, entry, size).then((data) => {
      if (live) setIcon(data);
    });
    return () => {
      live = false;
    };
    // The cache key carries the path, size, and file identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (icon) {
    return <img className="folder-entry-icon" src={icon} alt="" draggable={false}
      style={size <= 36
        ? { width: size, height: size }
        : { maxWidth: size, maxHeight: size }} />;
  }
  return <File size={Math.round(size * 0.7)} className="folder-entry-glyph" aria-hidden="true" />;
}

export function PreviewVisual({ path, entry }: { path: string; entry: DesktopFolderEntry }) {
  const [image, setImage] = useState("");
  const key = `${path}:${entry.mtimeMs}`;
  useEffect(() => {
    let live = true;
    setImage("");
    if (entry.dir) return undefined;
    void Promise.resolve(
      window.mixdogDesktop?.folderEntryIcon?.(path, true, 384) ?? "",
    )
      .then((data) => {
        if (live) setImage(data || "");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // The cache key carries the path and file identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (entry.dir) return <FolderGlyph size={96} />;
  if (!image) return <File size={72} className="folder-entry-glyph" aria-hidden="true" />;
  return <img className="folder-preview-image" src={image} alt="" draggable={false} />;
}
