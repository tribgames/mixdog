// A chat link to a local .html file, opened from a paired device in the PC's
// own browser pane exactly like on the desktop. The daemon confines the path
// (a registered project directory or a one-file selected-file grant, the same
// authority as the file previews); the window process, which owns the loopback
// page server, mints the lease. The device receives only the PC's loopback
// address and hands it back as a browser-pane navigation.
import { authorizedLocation, type PreviewGrants, remoteFileTarget } from './remote-file-preview';
import { sensitivePolicy } from './remote-sensitive-paths';
import type { DesktopService } from './desktop-service-contract';

export function createRemoteLocalPageMethods(deps: {
  host: Pick<DesktopService, 'projectDirectory'>;
  grants: PreviewGrants;
  hostRequest?: (method: 'localPageUrl', args: unknown[]) => Promise<unknown>;
}): Record<string, (params: unknown[]) => unknown> {
  const { host, grants, hostRequest } = deps;
  return {
    localPageUrl: async ([projectPath, relPath, accessToken]) => {
      if (!hostRequest) throw new TypeError('The desktop app is unavailable on this connection.');
      // The page is opened and authorized by where the open file really is
      // (openAuthorizedFile); the window process gets that real location and
      // this process's deny policy, which its page server applies to every
      // asset the page references.
      // A one-file grant serves that page alone; a project page its assets too.
      const target = await remoteFileTarget(host, grants, projectPath, relPath, accessToken);
      const page = await authorizedLocation(target.absolute, target.root);
      return hostRequest('localPageUrl', [page.root, page.rel, target.granted ? 'file' : 'project', sensitivePolicy()]);
    },
  };
}
