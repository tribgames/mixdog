/**
 * The file methods the core asks of the window process: a project file's
 * picture (`host/capture/fileSnapshot`) and a loopback lease for a local page
 * (`host/localPage/url`). The core has already confined the path; the host
 * only renders or mints, exactly as `captureFileSnapshot` / `localPageUrl`
 * did in the window-process request handler.
 */
import type {
  HostFileSnapshot,
  HostFileSnapshotParams,
  HostLocalPageUrlParams,
} from '../../../../../packages/protocol/src/index.ts';
import { HOST_COMMAND_FAILED, HostRpcError, type HostConnection, objectParams, type WireFields } from './connection';

export const HOST_FILE_SNAPSHOT = 'host/capture/fileSnapshot';
export const HOST_LOCAL_PAGE_URL = 'host/localPage/url';

export interface FilesControl {
  captureFileSnapshot(root: string, rel: string, grant: boolean): Promise<HostFileSnapshot>;
  /** The lease is owned by the main window, so it dies with it. */
  localPageUrl(root: string, rel: string, scope: 'file' | 'project'): Promise<string>;
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
  serve<HostLocalPageUrlParams>(HOST_LOCAL_PAGE_URL, (p) =>
    control().localPageUrl(String(p.root || ''), String(p.rel || ''), p.scope === 'file' ? 'file' : 'project')
  );
}
