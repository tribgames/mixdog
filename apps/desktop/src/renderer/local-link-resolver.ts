import { t } from './i18n';
import { isLocalMarkdownLink, localMarkdownPath, projectRelativeFilePath } from './markdown-url';
import { localLinkKind } from '../shared/local-files';

interface ResolvedLocalLink {
  project: string;
  path: string;
  accessToken?: string;
  directory?: boolean;
}

function projectKey(project: string): string {
  const path = project.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

function missingFile(error: unknown): boolean {
  const failure = error as { code?: string; message?: string };
  // Electron's invoke errors retain the Node error code in the message,
  // rather than preserving the Error object's custom `code` property.
  return failure?.code === 'ENOENT' || /\bENOENT\b/.test(String(failure?.message || ''));
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
  const found = (await api?.searchProjectFiles?.(project, path, 50)) || [];
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

/** Search relative names only in registered Projects. Explicit absolute links
 * can use the same file-scoped access as the native file picker. */
export async function resolveLocalLink(project: string, path: string): Promise<ResolvedLocalLink> {
  if (!isLocalMarkdownLink(path)) throw new Error(t("The file is outside the conversation's Project."));
  if (/^file:/i.test(path)) {
    const url = new URL(path);
    if (url.hostname && url.hostname !== 'localhost') {
      throw new Error(t("The file is outside the conversation's Project."));
    }
    path = url.href;
  }
  if (/^\\\\/.test(path)) throw new Error(t("The file is outside the conversation's Project."));
  const absolute = /^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(path);
  if (!project && !absolute) throw new Error(t("The conversation's Project is unavailable."));
  const relative = projectRelativeFilePath(project, path);
  // A relative traversal is not an absolute cross-Project link.
  if (!absolute && !relative) throw new Error(t("The file is outside the conversation's Project."));
  const searchable = Boolean(relative && !absolute && localLinkKind(path) === 'file');
  if (project && relative) {
    const match = uniqueTarget(await findInProject(project, relative, searchable), path);
    if (match) return match;
    // An absolute path cannot be redirected to another file with the same name.
    if (absolute) throw new Error(t('File not found in the Project: {{file}}', { file: path }));
  }
  const projects = (await window.mixdogDesktop?.listProjects?.()) || [];
  const others = [
    ...new Map(
      projects
        .filter((entry) => projectKey(entry.path) !== projectKey(project))
        .map((entry) => [projectKey(entry.path), entry.path])
    ).values(),
  ];
  if (absolute) {
    const owners = others
      .flatMap((root) => {
        const rel = projectRelativeFilePath(root, path);
        return rel ? [{ project: root, path: rel }] : [];
      })
      .sort((left, right) => right.project.length - left.project.length);
    if (!owners.length) {
      const target = localMarkdownPath(path);
      if (target.startsWith('//') || !/^(?:[a-z]:\/|\/)/i.test(target)) {
        throw new Error(t("The file is outside the conversation's Project."));
      }
      const resolvePaths = window.mixdogDesktop?.resolveLocalPaths;
      if (!resolvePaths) throw new Error(t('Local file links can only be opened in the desktop app.'));
      const [entry] = await resolvePaths([target]);
      if (!entry) throw new Error(t('File not found in the Project: {{file}}', { file: path }));
      if (entry.dir) return { project: entry.absolutePath, path: '.', directory: true };
      if (!entry.projectPath || !entry.relPath) {
        throw new Error(t('File not found in the Project: {{file}}', { file: path }));
      }
      return { project: entry.projectPath, path: entry.relPath, accessToken: entry.accessToken };
    }
    const owner = owners[0];
    const match = uniqueTarget(await findInProject(owner.project, owner.path, false), path);
    if (match) return match;
  } else {
    const matches = (await Promise.all(others.map((root) => findInProject(root, relative!, searchable)))).flat();
    const match = uniqueTarget(matches, path);
    if (match) return match;
  }
  throw new Error(t('File not found in the Project: {{file}}', { file: path }));
}
