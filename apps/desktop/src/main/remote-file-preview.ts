// Remote file previews over the ENCRYPTED RPC lane. The Electron preview
// protocol URLs mean nothing to a browser and the plaintext HTTP media lane is
// disabled, so the browser pulls bytes in bounded base64 ranges and builds
// blob: URLs (or a sandboxed srcdoc page) itself. Authorization is exactly the
// editor's: a registered project directory or a one-file selected-file grant.
import { open, stat } from 'node:fs/promises';

import { filePreviewTypeForPath } from '../shared/file-preview';
import { pageAssetType } from './local-page-server';
import { requiredString } from './ipc-validation';
import { projectEntryPathIn } from './project-files';
import { leaseMediaFile } from './media-leases';
import type { DesktopService } from './desktop-service-contract';

/** Raw bytes per read. Base64 makes it ~5.6 MB per frame, far below the
 *  relay's 64 MiB frame ceiling, and keeps one slow read from stalling the UI
 *  socket for long. */
export const REMOTE_PREVIEW_MAX_READ_BYTES = 4 * 1024 * 1024;

interface PreviewGrants {
  grantedFile(
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown
  ): { root: string; rel: string; absolute: string };
  grantedIf(accessToken: unknown): boolean;
}

type RemoteMethod = (params: unknown[]) => unknown;

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export function createRemoteFilePreviewMethods(deps: {
  host: Pick<DesktopService, 'projectDirectory'>;
  grants: PreviewGrants;
}): Record<string, RemoteMethod> {
  const { host, grants } = deps;
  const target = async (
    projectPath: unknown,
    relPath: unknown,
    accessToken: unknown
  ): Promise<{ root: string; absolute: string }> => {
    if (grants.grantedIf(accessToken)) {
      const granted = grants.grantedFile(accessToken, projectPath, relPath);
      return { root: granted.root, absolute: granted.absolute };
    }
    const root = await host.projectDirectory(requiredString(projectPath, 'projectPath'));
    return { root, absolute: projectEntryPathIn(root, requiredString(relPath, 'relPath', 4_096)) };
  };
  const fileInfo = async (absolute: string): Promise<{ mtimeMs: number; size: number }> => {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('The preview target is not a file.');
    return { mtimeMs: info.mtimeMs, size: info.size };
  };
  return {
    // Metadata only: the browser then reads the bytes through the range method.
    previewProjectFile: async ([projectPath, relPath, accessToken]) => {
      const { absolute } = await target(projectPath, relPath, accessToken);
      const type = filePreviewTypeForPath(absolute);
      if (!type) throw new Error('This file type does not support an in-app preview.');
      const info = await fileInfo(absolute);
      // Streamable kinds also get a lease the encrypted relay media lane can
      // serve; a browser without that lane ignores it and reads ranges below.
      const mediaAssetId = type.kind === 'pdf' ? undefined : leaseMediaFile(absolute, type.mime);
      return { kind: type.kind, mime: type.mime, ...info, ...(mediaAssetId ? { mediaAssetId } : {}) };
    },
    previewProjectFileRange: async ([projectPath, relPath, accessToken, rawOffset, rawLength]) => {
      const offset = integer(rawOffset, 'offset', 0, Number.MAX_SAFE_INTEGER);
      const length = integer(rawLength, 'length', 1, REMOTE_PREVIEW_MAX_READ_BYTES);
      const { root, absolute } = await target(projectPath, relPath, accessToken);
      const mime = filePreviewTypeForPath(absolute)?.mime || pageAssetType(root, absolute);
      if (!mime) throw new Error('This file type does not support an in-app preview.');
      const info = await fileInfo(absolute);
      const handle = await open(absolute, 'r');
      try {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, info.size - offset)));
        const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
        return { data: buffer.subarray(0, bytesRead).toString('base64'), mime, offset, ...info };
      } finally {
        await handle.close();
      }
    },
  };
}
