/**
 * The file methods the core asks of the window process: a project file's
 * picture (`host/capture/fileSnapshot`) and the OS trash (`host/files/trashItem`).
 * The core has already confined the path; the host only renders or trashes.
 * Local pages are served by the core's own page server, not by the window process.
 */
import type {
  HostFileSnapshot,
  HostFileSnapshotParams,
} from '../../../../../packages/protocol/src/index.ts';
import { HOST_COMMAND_FAILED, HostRpcError, type HostConnection, objectParams, type WireFields } from './connection';

export const HOST_FILE_SNAPSHOT = 'host/capture/fileSnapshot';
export const HOST_TRASH_ITEM = 'host/files/trashItem';

export interface FilesControl {
  captureFileSnapshot(root: string, rel: string, grant: boolean): Promise<HostFileSnapshot>;
  /** The OS trash (Electron's `shell.trashItem`); the core has already confined the path. */
  trashItem(path: string): Promise<void>;
}

export function registerFilesHost(connection: HostConnection, control: () => FilesControl): void {
  const serve = <P extends object>(method: string, run: (params: WireFields<P>) => Promise<unknown>) =>
    connection.handleRequest(method, async (params) => {
      const fields = objectParams<P>(params, method);
      try {
        return await run(fields);
      } catch (error) {
        throw new HostRpcError(HOST_COMMAND_FAILED, (error as Error)?.message || String(error));
      }
    });
  serve<HostFileSnapshotParams>(HOST_FILE_SNAPSHOT, (p) =>
    control().captureFileSnapshot(String(p.root || ''), String(p.rel || ''), p.grant === true)
  );
  serve<{ path: string }>(HOST_TRASH_ITEM, async (p) => {
    await control().trashItem(String(p.path || ''));
    return {};
  });
}
