// A chat link to a local .html file, opened from a paired device in the PC's
// own browser pane exactly like on the desktop. The daemon resolves the path
// as the desktop handler does (a registered project directory or a one-file
// selected-file grant, the same authority as the file previews); the window
// process, which owns the loopback page server, mints the same lease the
// desktop gets. The device receives only the PC's loopback address and hands
// it back as a browser-pane navigation.
import { type PreviewGrants, remoteFileTarget } from './remote-file-preview';
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
      // A one-file grant serves that page alone; a project page its assets too.
      const target = await remoteFileTarget(host, grants, projectPath, relPath, accessToken);
      return hostRequest('localPageUrl', [target.root, target.rel, target.granted ? 'file' : 'project']);
    },
  };
}
