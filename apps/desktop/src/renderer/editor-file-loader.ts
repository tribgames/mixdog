import type {
  DesktopApi,
  DesktopEditorBackup,
  DesktopTextFileEncoding,
} from "../shared/contract";
import { filePreviewTypeForPath } from "../shared/file-preview";
import {
  beginEditorLoad,
  editorLoadKey,
  ensureEditorLoad,
  reportEditorLoadStage,
} from "./renderer-load-metrics";

export interface EditorFileLoad {
  content: string;
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  encoding: DesktopTextFileEncoding;
}

export interface EditorFileHydration {
  file: EditorFileLoad;
  backup: DesktopEditorBackup | null;
}

export interface EditorBackupResolution {
  content: string;
  savedContent: string;
  recovery: (DesktopEditorBackup & {
    diskChanged: boolean;
    restored: boolean;
  }) | null;
  discardBackup: boolean;
}

// Monaco normalizes mixed line endings when it creates a text model. Mirror
// its piece-tree rule so the saved model baseline is not confused with the
// byte-for-byte disk baseline used for optimistic writes.
export function normalizeEditorModelText(content: string): string {
  let cr = 0;
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 13) {
      if (content.charCodeAt(index + 1) === 10) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (code === 10) {
      lf += 1;
    }
  }
  const total = cr + lf + crlf;
  if (!total) return content;
  const eol = cr + crlf > total / 2 ? "\r\n" : "\n";
  if ((eol === "\r\n" && cr === 0 && lf === 0)
    || (eol === "\n" && cr === 0 && crlf === 0)) {
    return content;
  }
  return content.replace(/\r\n|\r|\n/g, eol);
}

export function resolveEditorBackup(
  diskContent: string,
  backup: DesktopEditorBackup | null,
): EditorBackupResolution {
  const savedContent = normalizeEditorModelText(diskContent);
  if (!backup) {
    return { content: savedContent, savedContent, recovery: null, discardBackup: false };
  }
  const backupContent = normalizeEditorModelText(backup.content);
  const expectedContent = normalizeEditorModelText(backup.expectedContent);
  if (backupContent === savedContent || backupContent === expectedContent) {
    return { content: savedContent, savedContent, recovery: null, discardBackup: true };
  }
  const diskChanged = backup.expectedContent !== diskContent;
  return {
    content: diskChanged ? savedContent : backupContent,
    savedContent,
    recovery: {
      ...backup,
      content: backupContent,
      diskChanged,
      restored: !diskChanged,
    },
    discardBackup: false,
  };
}

type PrimedEditorFile = {
  createdAt: number;
  promise: Promise<EditorFileHydration>;
};

const NEW_FILE_READ_RETRY_DELAYS_MS = [0, 60, 180] as const;
const PRIMED_FILE_MAX_AGE_MS = 10_000;
const PRIMED_FILE_LIMIT = 24;
const primedEditorFiles = new Map<string, PrimedEditorFile>();

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readEditorFile(
  api: DesktopApi,
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  retryMissing: boolean,
): Promise<EditorFileLoad> {
  const reader = api.readProjectFile;
  if (!reader) throw new Error("Desktop file access is unavailable.");
  const startedAt = now();
  let lastError: unknown;
  const delays = retryMissing ? NEW_FILE_READ_RETRY_DELAYS_MS : [0] as const;
  for (const delayMs of delays) {
    if (delayMs > 0) await delay(delayMs);
    try {
      const result = await reader(projectPath, relPath, accessToken);
      reportEditorLoadStage(
        projectPath,
        relPath,
        accessToken,
        "file-read",
        `read=${Math.max(0, now() - startedAt).toFixed(1)}ms bytes=${result.content.length}`,
      );
      return result;
    } catch (reason) {
      lastError = reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!retryMissing || !/ENOENT|no such file|cannot find|not found/i.test(message)) throw reason;
    }
  }
  throw lastError;
}

function startEditorFileHydration(
  api: DesktopApi,
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  retryMissing: boolean,
  includeBackup: boolean,
): Promise<EditorFileHydration> {
  ensureEditorLoad(projectPath, relPath, accessToken);
  const file = readEditorFile(api, projectPath, relPath, accessToken, retryMissing);
  const backup = includeBackup && api.readEditorBackup
    ? api.readEditorBackup(projectPath, relPath, accessToken).catch(() => null)
    : Promise.resolve(null);
  return Promise.all([file, backup]).then(([loaded, recovered]) => ({
    file: loaded,
    backup: recovered,
  }));
}

function prunePrimedEditorFiles(): void {
  const cutoff = Date.now() - PRIMED_FILE_MAX_AGE_MS;
  for (const [key, entry] of primedEditorFiles) {
    if (entry.createdAt < cutoff) primedEditorFiles.delete(key);
  }
  while (primedEditorFiles.size > PRIMED_FILE_LIMIT) {
    const oldest = primedEditorFiles.keys().next().value;
    if (!oldest) break;
    primedEditorFiles.delete(oldest);
  }
}

export function primeEditorFileLoad(
  api: DesktopApi | undefined,
  projectPath: string,
  relPath: string,
  accessToken?: string,
): Promise<EditorFileHydration> | null {
  if (!api?.readProjectFile || filePreviewTypeForPath(relPath)) return null;
  beginEditorLoad(projectPath, relPath, accessToken);
  prunePrimedEditorFiles();
  const key = editorLoadKey(projectPath, relPath, accessToken);
  const existing = primedEditorFiles.get(key);
  if (existing) return existing.promise;
  const promise = startEditorFileHydration(
    api,
    projectPath,
    relPath,
    accessToken,
    true,
    true,
  ).catch((error) => {
    if (primedEditorFiles.get(key)?.promise === promise) primedEditorFiles.delete(key);
    throw error;
  });
  primedEditorFiles.set(key, { createdAt: Date.now(), promise });
  prunePrimedEditorFiles();
  return promise;
}

export function takeEditorFileLoad(
  api: DesktopApi,
  projectPath: string,
  relPath: string,
  accessToken: string | undefined,
  retryMissing: boolean,
  includeBackup: boolean,
): Promise<EditorFileHydration> {
  const key = editorLoadKey(projectPath, relPath, accessToken);
  const primed = primedEditorFiles.get(key);
  if (primed && Date.now() - primed.createdAt <= PRIMED_FILE_MAX_AGE_MS && includeBackup) {
    primedEditorFiles.delete(key);
    return primed.promise;
  }
  primedEditorFiles.delete(key);
  return startEditorFileHydration(
    api,
    projectPath,
    relPath,
    accessToken,
    retryMissing,
    includeBackup,
  );
}
