import type {
  DesktopApi,
  DesktopLocalPathEntry,
} from "../shared/contract";
import { localFileMimeTypeForPath } from "../shared/local-files";

export const MIXDOG_PROJECT_PATHS_MIME = "application/x-mixdog-project-paths";
export const MIXDOG_ABSOLUTE_PATHS_MIME = "application/x-mixdog-folder-paths";

export type MixdogFileDragPayload =
  | { kind: "project"; projectPath: string; paths: string[] }
  | { kind: "absolute"; paths: string[] };

function transferTypes(transfer: DataTransfer): string[] {
  return Array.from(transfer.types ?? []);
}

function cleanStringPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((path) => path.trim()).filter(Boolean))].slice(0, 100);
}

export function dataTransferHasPathPayload(transfer: DataTransfer): boolean {
  const types = transferTypes(transfer);
  return types.includes(MIXDOG_PROJECT_PATHS_MIME)
    || types.includes(MIXDOG_ABSOLUTE_PATHS_MIME);
}

export function dataTransferHasLocalFiles(transfer: DataTransfer): boolean {
  return transferTypes(transfer).includes("Files") || dataTransferHasPathPayload(transfer);
}

export function readFileDragPayload(transfer: DataTransfer): MixdogFileDragPayload | null {
  if (transferTypes(transfer).includes(MIXDOG_PROJECT_PATHS_MIME)) {
    try {
      const value = JSON.parse(transfer.getData(MIXDOG_PROJECT_PATHS_MIME) || "{}");
      const projectPath = String(value?.projectPath || "").trim();
      const paths = cleanStringPaths(value?.paths);
      if (projectPath && paths.length) return { kind: "project", projectPath, paths };
    } catch {
      return null;
    }
  }
  if (transferTypes(transfer).includes(MIXDOG_ABSOLUTE_PATHS_MIME)) {
    try {
      const paths = cleanStringPaths(JSON.parse(
        transfer.getData(MIXDOG_ABSOLUTE_PATHS_MIME) || "[]",
      ));
      if (paths.length) return { kind: "absolute", paths };
    } catch {
      return null;
    }
  }
  return null;
}

function joinProjectPath(root: string, rel: string): string {
  const cleanRel = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleanRel || cleanRel.split("/").includes("..") || /^[A-Za-z]:/.test(cleanRel)) return "";
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${cleanRel.replace(/\//g, separator)}`;
}

export function absolutePathsForDragPayload(payload: MixdogFileDragPayload | null): string[] {
  if (!payload) return [];
  if (payload.kind === "absolute") return payload.paths;
  return payload.paths.map((path) => joinProjectPath(payload.projectPath, path)).filter(Boolean);
}

export function droppedLocalPaths(transfer: DataTransfer): string[] {
  const custom = absolutePathsForDragPayload(readFileDragPayload(transfer));
  const native = Array.from(transfer.files ?? [])
    .map((file) => window.mixdogDesktop?.folderPathForFile?.(file) || "")
    .filter(Boolean);
  return [...new Set([...custom, ...native])].slice(0, 100);
}

export async function localFilesFromPaths(
  api: DesktopApi,
  paths: string[],
  limit = 8,
): Promise<{
  files: File[];
  directories: DesktopLocalPathEntry[];
  errors: string[];
}> {
  const files: File[] = [];
  const directories: DesktopLocalPathEntry[] = [];
  const errors: string[] = [];
  if (!api.resolveLocalPaths || !api.readLocalFile || !paths.length) {
    return { files, directories, errors };
  }
  let entries: DesktopLocalPathEntry[];
  try {
    entries = await api.resolveLocalPaths(paths);
  } catch (reason) {
    return {
      files,
      directories,
      errors: [reason instanceof Error ? reason.message : String(reason)],
    };
  }
  for (const entry of entries) {
    if (entry.dir) {
      directories.push(entry);
      continue;
    }
    if (files.length >= limit) continue;
    try {
      const loaded = await api.readLocalFile(entry.absolutePath);
      const binary = atob(loaded.data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      files.push(new File([bytes], loaded.name, {
        type: loaded.mimeType || localFileMimeTypeForPath(loaded.name),
      }));
    } catch (reason) {
      errors.push(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return { files, directories, errors };
}

export async function materializeDroppedFiles(
  api: DesktopApi,
  transfer: DataTransfer,
  limit = 8,
): Promise<{
  files: File[];
  directories: DesktopLocalPathEntry[];
  errors: string[];
}> {
  const native = Array.from(transfer.files ?? []).slice(0, limit);
  if (native.length) return { files: native, directories: [], errors: [] };
  return localFilesFromPaths(
    api,
    absolutePathsForDragPayload(readFileDragPayload(transfer)),
    limit,
  );
}

function quoteTerminalPath(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) {
    return `"${path.replace(/"/g, '""')}"`;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function terminalPathText(paths: string[]): string {
  return paths.map(quoteTerminalPath).join(" ");
}
