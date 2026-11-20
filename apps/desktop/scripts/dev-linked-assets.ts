// The dev server and a node_modules that is a link (a worktree that shares another checkout's install).
//
// Vite resolves a package to its real location, so a stylesheet of such a package names its fonts as
// `/@fs/<real path>`. Two things then keep the file from being served, and the renderer gets something that is not a
// font ("OTS parsing error: invalid sfntVersion"):
//   - the real location is outside `server.fs.allow`: a 403 page. `linkedModuleRoots` names it for the allow list.
//   - the real location is on another Windows drive than the dev server's working directory: Vite's `/@fs/` handler
//     drops the drive letter and looks under the root of its own drive, finds nothing, and the request falls through
//     to the page fallback (index.html). `otherDriveAssets` serves that file from the drive the request names.
import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, parse, resolve } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

const FS_PREFIX = '/@fs/';
/** A query that makes an asset request a module request, which the dev server transforms itself. */
const MODULE_QUERY = /[?&](?:import|url|raw|inline|worker|sharedworker|html-proxy)(?:[=&]|$)/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

/** The real location of `dir`'s node_modules, for `server.fs.allow`; nothing when there is none. */
export function linkedModuleRoots(dir: string, realpath: (path: string) => string = realpathSync.native): string[] {
  try {
    return [realpath(resolve(dir, 'node_modules'))];
  } catch {
    return [];
  }
}

/** The drive letter of the folder Vite's `/@fs/` handler serves from (the root of the working directory's drive). */
export function ownDrive(cwdRoot: string = parse(resolve('/')).root): string {
  return /^[A-Za-z]:/.test(cwdRoot) ? cwdRoot[0].toUpperCase() : '';
}

/**
 * The file (`C:/dir/name.woff2`) a `/@fs/<drive>:/...` asset request names when `<drive>` is not `own`; null for
 * every other request, which the dev server answers as before.
 */
export function otherDriveFile(url: string, own: string): string | null {
  if (!own || !url.startsWith(FS_PREFIX)) return null;
  const queryAt = url.indexOf('?');
  if (queryAt !== -1 && MODULE_QUERY.test(url.slice(queryAt))) return null;
  let pathname: string;
  try {
    pathname = decodeURI(queryAt === -1 ? url : url.slice(0, queryAt));
  } catch {
    return null;
  }
  const file = pathname.slice(FS_PREFIX.length);
  const drive = /^([A-Za-z]):\//.exec(file);
  if (!drive || drive[1].toUpperCase() === own) return null;
  if (file.split('/').some((part) => part === '..' || part === '.')) return null;
  return file;
}

type Headers = Record<string, string | string[] | number | undefined>;

export interface OtherDriveAssetOptions {
  /** `ownDrive()`. */
  own: string;
  /** Whether the dev server may serve `file` (an asset inside `server.fs.allow`). */
  serves(file: string): boolean;
  /** `server.headers` of the dev server. */
  headers?(): Headers | undefined;
}

/** The middleware of `otherDriveAssets`: answers the asset of another drive, hands every other request on. */
export function otherDriveAssetHandler({ own, serves, headers }: OtherDriveAssetOptions) {
  return (req: Pick<IncomingMessage, 'method' | 'url'>, res: ServerResponse, next: () => void): void => {
    const file = req.method === 'GET' || req.method === 'HEAD' ? otherDriveFile(req.url ?? '', own) : null;
    if (!file || !serves(file)) {
      next();
      return;
    }
    let size: number;
    try {
      const stats = statSync(file);
      if (!stats.isFile()) {
        next();
        return;
      }
      size = stats.size;
    } catch {
      next();
      return;
    }
    for (const [name, value] of Object.entries(headers?.() ?? {})) if (value !== undefined) res.setHeader(name, value);
    res.statusCode = 200;
    res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

/**
 * Dev server only: an asset of a package whose real location is on another Windows drive is served from that drive.
 * `allowed` is Vite's `isFileLoadingAllowed`.
 */
export function otherDriveAssets(allowed: (config: ResolvedConfig, file: string) => boolean): Plugin {
  return {
    name: 'mixdog-other-drive-assets',
    apply: 'serve',
    configureServer(server) {
      const own = ownDrive();
      if (!own) return;
      server.middlewares.use(
        otherDriveAssetHandler({
          own,
          serves: (file) => server.config.assetsInclude(file) && allowed(server.config, file),
          headers: () => server.config.server.headers as Headers | undefined,
        })
      );
    },
  };
}
