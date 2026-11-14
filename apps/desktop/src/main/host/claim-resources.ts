import { dirname, join } from 'node:path';

import type { HostClaimResources } from '../../../../../packages/protocol/src/index.ts';
import { coreBinaryPath } from '../protocol/local-core';

/**
 * `host/claim` `resources`: where this desktop keeps what the core launches. Packaged, the server cores are
 * `resources/server-cores` and the askpass helper sits beside the core binary (`resources/core`). A field whose path is not
 * there is left out, so the core reads what it has: it also reads MIXDOG_SERVER_CORES_DIR and MIXDOG_ASKPASS_HELPER, and in a
 * source checkout it finds the staged server cores and the helper beside its own executable.
 */
export function claimResources(
  packaged: boolean,
  resourcesPath: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform
): HostClaimResources {
  const serverCores = join(resourcesPath, 'server-cores');
  const askpass = join(
    dirname(coreBinaryPath(packaged, resourcesPath, platform)),
    platform === 'win32' ? 'mixdog-askpass.exe' : 'mixdog-askpass'
  );
  return {
    ...(exists(serverCores) ? { serverCoresDir: serverCores } : {}),
    ...(exists(askpass) ? { askpassHelper: askpass } : {}),
  };
}
