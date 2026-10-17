import { t } from './i18n';
import { isLocalMarkdownLink, localMarkdownPath, projectRelativeFilePath } from './markdown-url';
import { fileErrorCode, PROJECT_UNAVAILABLE } from '../shared/file-error-codes';
import { localLinkKind } from '../shared/local-files';

export interface ResolvedLocalLink {
  project: string;
  path: string;
  accessToken?: string;
  directory?: boolean;
}

function projectKey(project: string): string {
  const path = project.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

// Errors are told apart by their structured `code` (the preload and the remote
// client rebuild it on the error), never by their message: a message can carry
// a file name such as "ENOENT.txt" and is only for display.
function missingFile(error: unknown): boolean {
  return fileErrorCode(error) === 'ENOENT';
}

/** A Project that holds no answer: its folder is gone, or the folder is not
 *  a registered Project. Anything else (an access or path-boundary refusal,
 *  an I/O fault) is the link's real answer and is never replaced by a miss. */
function projectUnavailable(error: unknown): boolean {
  return missingFile(error) || fileErrorCode(error) === PROJECT_UNAVAILABLE;
}

async function findInProject(project: string, path: string, search: boolean): Promise<ResolvedLocalLink[]> {
  const api = window.mixdogDesktop;
  if (api?.statProjectFile) {
    try {
      await api.statProjectFile(project, path);
      return [{ project, path }];
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  } else if (!search || path.includes('/')) {
    return [{ project, path }];
  }
  if (!search) return [];
  // Chat replies name deliverables and build outputs, which usually sit in
  // gitignored folders the file picker leaves out.
  const found = (await api?.searchProjectFiles?.(project, path, 50, true)) || [];
  return found.flatMap((candidate) => {
    const relative = projectRelativeFilePath(project, candidate);
    return relative &&
      (relative.toLowerCase() === path.toLowerCase() || relative.toLowerCase().endsWith(`/${path.toLowerCase()}`))
      ? [{ project, path: relative }]
      : [];
  });
}

function uniqueTarget(matches: ResolvedLocalLink[], name: string): ResolvedLocalLink | null {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${t('Several files are named {{file}}; link a path with folders.', { file: name })}\n${matches
        .map((match) => `${match.project.replace(/[\\/]+$/, '')}/${match.path}`)
        .join('\n')}`
    );
  }
  return null;
}

/** An absolute path opens wherever it is: through the deepest registered
 *  Project that contains it, otherwise with a one-off file grant, the same
 *  access the native file picker gives. */
async function resolveAbsolute(target: string, path: string, sessionId?: string): Promise<ResolvedLocalLink> {
  const resolvePaths = window.mixdogDesktop?.resolveLocalPaths;
  if (!resolvePaths) throw new Error(t('Local file links can only be opened in the desktop app.'));
  // The conversation lets a paired device's host find the reply that links it.
  const [entry] = await (sessionId ? resolvePaths([target], sessionId) : resolvePaths([target])).catch(
    (error: unknown) => {
      if (missingFile(error)) return [];
      throw error;
    }
  );
  if (entry?.dir) return { project: entry.absolutePath, path: '.', directory: true };
  if (!entry?.projectPath || !entry.relPath) {
    throw Object.assign(new Error(t('File not found (it may have been deleted or moved): {{file}}', { file: path })), {
      code: 'ENOENT',
    });
  }
  return entry.accessToken
    ? { project: entry.projectPath, path: entry.relPath, accessToken: entry.accessToken }
    : { project: entry.projectPath, path: entry.relPath };
}

/** Relative names resolve in the conversation's folder, then by name in the
 *  registered Projects. Absolute paths, `../` paths and files of a folder that
 *  is not itself a registered Project open by their absolute location. */
export async function resolveLocalLink(project: string, path: string, sessionId?: string): Promise<ResolvedLocalLink> {
  if (!isLocalMarkdownLink(path)) throw new Error(t("The file is outside the conversation's Project."));
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    path = url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${url.pathname}` : url.href;
  }
  // Markdown encodes `C:\a\b.png` as `C:%5Ca%5Cb.png`; judge the decoded path.
  const decoded = localMarkdownPath(path);
  if (/^file:/i.test(path) || /^(?:[a-z]:\/|\/)/i.test(decoded)) return resolveAbsolute(decoded, path, sessionId);
  if (!project) throw new Error(t("The conversation's Project is unavailable."));
  const relative = projectRelativeFilePath(project, path);
  const searchable = Boolean(relative && localLinkKind(path) === 'file');
  let found: ResolvedLocalLink[] | null = null;
  if (relative) {
    try {
      found = await findInProject(project, relative, searchable);
    } catch (error) {
      // The conversation may run in a folder that is not a registered Project.
      if (!projectUnavailable(error)) throw error;
    }
  }
  if (found) {
    const match = uniqueTarget(found, path);
    if (match) return match;
  } else {
    const target = `${project.replace(/\\/g, '/').replace(/\/+$/, '')}/${localMarkdownPath(path)}`;
    try {
      return await resolveAbsolute(target, path, sessionId);
    } catch (error) {
      // Only a miss goes on to the other Projects.
      if (!searchable || !missingFile(error)) throw error;
    }
  }
  const projects = (await window.mixdogDesktop?.listProjects?.()) || [];
  const others = [
    ...new Map(
      projects
        .filter((entry) => projectKey(entry.path) !== projectKey(project))
        .map((entry) => [projectKey(entry.path), entry.path])
    ).values(),
  ];
  // A registered Project whose folder is gone holds no match; it must not
  // turn a plain miss into its own ENOENT. An access refusal in any of them
  // is still the answer.
  const matches = (
    await Promise.all(
      others.map((root) =>
        findInProject(root, relative!, searchable).catch((error: unknown) => {
          if (projectUnavailable(error)) return [];
          throw error;
        })
      )
    )
  ).flat();
  const match = uniqueTarget(matches, path);
  if (match) return match;
  throw new Error(t('File not found in the Project: {{file}}', { file: path }));
}

// Rendering verifies every filename mention in a transcript, and one name is
// often mentioned many times: each (Project, path) costs one request per
// file service while it is in flight or recently settled. A found file stays
// verified briefly; a missing one retries soon, since it may be about to be
// written.
const VERIFIED_TTL_MS = 30_000;
const MISSING_TTL_MS = 3_000;
/** The target a click opens. A verified location is reused as is, but a file
 *  outside every Project carries a one-off access token that main may have
 *  dropped since (grants are capped): it is described again at click time, so
 *  a link reopened later never presents an expired token. */
export function resolveLocalLinkForOpen(
  verified: ResolvedLocalLink | null | undefined,
  project: string,
  path: string,
  sessionId?: string
): Promise<ResolvedLocalLink> {
  if (verified && !verified.accessToken) return Promise.resolve(verified);
  return resolveLocalLink(project, path, sessionId);
}

const VERIFICATION_CACHE_LIMIT = 256;

interface Verification {
  result: Promise<ResolvedLocalLink>;
  expiresAt: number;
}

const verifications = new WeakMap<object, Map<string, Verification>>();

/** Confirm that an automatic mention names an existing file or folder: the
 *  conversation's Project first, then the other registered Projects (or the
 *  exact absolute path). Remote searches run in their own call lane, so this
 *  never queues other calls behind a Project index walk. Resolution results
 *  may be stale, so the resolved file is statted as well. */
export function verifyLocalLink(project: string, path: string, sessionId?: string): Promise<ResolvedLocalLink> {
  const api = window.mixdogDesktop;
  const statProjectFile = api?.statProjectFile;
  // Never trust the resolver's no-stat compatibility fallback.
  if (!api || !statProjectFile) {
    return Promise.reject(new Error(t('Local file links can only be opened in the desktop app.')));
  }
  let cache = verifications.get(api);
  if (!cache) {
    cache = new Map();
    verifications.set(api, cache);
  }
  const key = `${project}\0${path}\0${sessionId ?? ''}`;
  const cached = cache.get(key);
  cache.delete(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.set(key, cached);
    return cached.result;
  }
  const result = resolveLocalLink(project, path, sessionId).then(async (match) => {
    // External folders were already statted by resolveLocalPaths and open
    // in the file manager, without an editor access token.
    if (!match.directory) await statProjectFile(match.project, match.path, match.accessToken);
    return match;
  });
  const entry: Verification = { result, expiresAt: Number.POSITIVE_INFINITY };
  cache.set(key, entry);
  while (cache.size > VERIFICATION_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  result.then(
    () => {
      entry.expiresAt = Date.now() + VERIFIED_TTL_MS;
    },
    () => {
      entry.expiresAt = Date.now() + MISSING_TTL_MS;
    }
  );
  return result;
}
