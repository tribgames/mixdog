import { createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { showDesktopToast } from './desktop-toasts';
import { SetiFileIcon } from './SetiFileIcon';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { localPathMentionHref, PATH_LINK_CLASS } from './markdown-plugins';
import { isLocalMarkdownLink, projectRelativeFilePath } from './markdown-url';
import { prefetchEditorPane, scheduleEditorPanePrefetch } from './lazy-widgets';
import { resolveLocalLink, type ResolvedLocalLink } from './local-link-resolver';
import { localFileOpener, localLinkKind, parseLocalFileLocation } from '../shared/local-files';

/** Plain text of rendered children: highlighted code and link captions are
 *  hast-derived spans, so a String() cast would not yield their source. */
export function childrenText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(childrenText).join('');
  if (isValidElement(node)) return childrenText((node.props as { children?: ReactNode }).children);
  return '';
}

// The owning conversation supplies its Project, not the globally active pane.
export const MarkdownProjectContext = createContext('');
/** Opens a Project file in Mixdog's editor at a line; the conversation host
 *  supplies it. Binary documents/media never come here — they go to the OS. */
export type MarkdownOpenFile = (project: string, rel: string, line?: number, accessToken?: string) => void;
export const MarkdownOpenFileContext = createContext<MarkdownOpenFile | null>(null);

function displayPath(project: string, rel: string, suffix: string): string {
  const separator = project.includes('\\') ? '\\' : '/';
  return `${project.replace(/[\\/]+$/, '')}${separator}${rel.replace(/\//g, separator)}${suffix}`;
}

export interface LocalLinkTarget {
  /** False for web URLs, anchors and unsupported schemes. */
  local: boolean;
  /** True only after an automatic mention's resolved target has been statted. */
  verified: boolean;
  path: string;
  kind: 'folder' | 'file' | 'unknown';
  /** Display name: file name, or `folder/`. */
  name: string;
  /** `:line[:column]` when the link carries one. */
  suffix: string;
  /** Full path for the tooltip; bare names fill it in after `revealTitle`. */
  title?: string;
  /** Hover intent: warms the editor chunk and fills the tooltip in. */
  revealTitle?: () => void;
  /** Press intent, for touch surfaces that never hover: start the editor
   *  chunk now so the click itself no longer pays for it. */
  warmEditor: () => void;
  open: () => Promise<void>;
}

/** One opening rule for every local mention (chat links, tool subjects):
 *  text files go to Mixdog's editor at their line, documents launch the OS
 *  app, folders open in the file manager. Each file uses its owning Project,
 *  which may differ from the conversation's current Project. */
function useLocalLinkTarget(target: string, verify = false): LocalLinkTarget {
  const projectPath = useContext(MarkdownProjectContext);
  const openFile = useContext(MarkdownOpenFileContext);
  const [resolved, setResolved] = useState<{ key: string; title: string; target: ResolvedLocalLink | null }>({
    key: '',
    title: '',
    target: null,
  });
  const [verifiedKey, setVerifiedKey] = useState('');
  const resolutionKey = `${projectPath}\0${target}`;
  const resolvedTitle = resolved.key === resolutionKey ? resolved.title : '';
  const resolvedTarget = resolved.key === resolutionKey ? resolved.target : null;
  const local = isLocalMarkdownLink(target);
  const location = parseLocalFileLocation(target);
  const kind = localLinkKind(location.path);
  const rel = local ? projectRelativeFilePath(projectPath, location.path) : null;
  // Only a relative mention without folders is a bare name; `C:/work/a.docx`
  // at the Project root is already exact.
  const bare = Boolean(
    rel && kind === 'file' && !rel.includes('/') && !/^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(location.path)
  );
  const columnSuffix = location.column ? `:${location.column}` : '';
  const suffix = location.line ? `:${location.line}${columnSuffix}` : '';
  const name =
    (location.path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || location.path) + (kind === 'folder' ? '/' : '');
  const title = resolvedTitle || (rel && !bare && projectPath ? displayPath(projectPath, rel, suffix) : undefined);

  // A filename-shaped mention is not an authored link. Keep it noninteractive
  // until the owning Project and actual file/folder are confirmed.
  // Search results may be stale; stat the resolved path as well. Do not use
  // the resolver's legacy no-stat fallback as evidence that a file exists.
  useEffect(() => {
    if (!verify || !local) return;
    setVerifiedKey('');
    const statProjectFile = window.mixdogDesktop?.statProjectFile;
    if (!statProjectFile) return;
    let active = true;
    resolveLocalLink(projectPath, location.path)
      .then(async (match) => {
        if (!active) return;
        // External folders were already statted by resolveLocalPaths and
        // open in the file manager, without an editor access token.
        if (!match.directory) await statProjectFile(match.project, match.path, match.accessToken);
        if (!active) return;
        setResolved({
          key: resolutionKey,
          title: displayPath(match.project, match.path, suffix),
          target: match,
        });
        setVerifiedKey(resolutionKey);
      })
      // Missing, ambiguous, inaccessible or unverified mentions remain text.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [verify, local, projectPath, location.path, resolutionKey, suffix]);

  // The first paint (verified mentions) and hover both resolve this exact
  // link already. Reusing that result keeps the click from paying a second
  // round trip to the file service — for a bare name that trip is a whole
  // project-index search — before anything can start opening.
  const resolveTarget = async (): Promise<ResolvedLocalLink> => {
    if (resolvedTarget) return resolvedTarget;
    const match = await resolveLocalLink(projectPath, location.path);
    setResolved({ key: resolutionKey, title: displayPath(match.project, match.path, suffix), target: match });
    return match;
  };
  // Chat links deserve the file tree's treatment: start Monaco's chunk on the
  // open intent, rather than paying its whole fetch + evaluate after the
  // click, behind the path resolution.
  const editorTarget = local && kind === 'file' && localFileOpener(location.path) === 'editor';
  const warmEditor = () => {
    if (editorTarget) void prefetchEditorPane().catch(() => {});
  };
  const open = async () => {
    warmEditor();
    try {
      const { project, path: file, accessToken, directory } = await resolveTarget();
      // A text file with an extension opens in the editor directly. Documents,
      // folders and extension-less names go through main, which launches the
      // OS app or file manager and hands text files back as 'editor'.
      if (directory || kind !== 'file' || localFileOpener(file) === 'os') {
        const api = window.mixdogDesktop;
        if (!api?.openLocalFileLink) {
          throw new Error(t('Local file links can only be opened in the desktop app.'));
        }
        // Main reads the href as a URL path: `report #1.docx` must travel as
        // `report%20%231.docx` or the `#` would start a fragment.
        const href = file.split('/').map(encodeURIComponent).join('/');
        if ((await api.openLocalFileLink(project, href)) !== 'editor') return;
      }
      if (!openFile) throw new Error(t('Local file links can only be opened in the desktop app.'));
      if (accessToken) openFile(project, file, location.line, accessToken);
      else openFile(project, file, location.line);
    } catch (error) {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    }
  };
  // Hover is the earliest reliable open intent on a pointer surface: warm the
  // editor chunk there, and resolve cross-Project paths too. The resolution is
  // cached only for this exact conversation cwd and link, never a preceding
  // Project or target.
  const revealTitle = local
    ? () => {
        if (editorTarget) scheduleEditorPanePrefetch();
        if (resolvedTitle) return;
        resolveTarget().catch(() => {});
      }
    : undefined;
  return {
    local,
    verified: verifiedKey === resolutionKey,
    path: location.path,
    kind,
    name,
    suffix,
    title,
    revealTitle,
    warmEditor,
    open,
  };
}

/** The explorer's file glyph, so a file reads the same in chat as in the
 *  tree. Folders carry no glyph there either. */
function LocalLinkIcon({ target }: { target: LocalLinkTarget }) {
  if (target.kind === 'folder') return null;
  return <SetiFileIcon name={target.name} />;
}

/** Tool-card subject that names a file: same rule and look as a chat link,
 *  as a span because it sits inside the card's header button. */
export function LocalPathMention({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const link = useLocalLinkTarget(line ? `${path}:${line}` : path);
  if (!link.local) return <>{children}</>;
  return (
    <span
      role="link"
      className="tool-path-link"
      title={link.title}
      onMouseEnter={link.revealTitle}
      onPointerDown={(event) => {
        event.stopPropagation();
        link.warmEditor();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void link.open();
      }}
    >
      <LocalLinkIcon target={link} />
      {children}
    </span>
  );
}

export function MarkdownLink({
  href,
  children,
  className,
  title,
}: {
  href?: string;
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  const raw = String(href || '').trim();
  const text = childrenText(children).trim();
  const pendingTarget = !raw ? localPathMentionHref(text) : null;
  const target = /^www\./i.test(raw) ? `https://${raw}` : raw || pendingTarget || '';
  const external = /^https?:\/\//i.test(target);
  const automatic = String(className || '')
    .split(/\s+/)
    .includes(PATH_LINK_CLASS);
  const verify = automatic && typeof window !== 'undefined';
  const link = useLocalLinkTarget(target, verify);
  const local = link.local;
  const pathLike =
    local &&
    (automatic ||
      Boolean(pendingTarget) ||
      text === raw ||
      text === link.path.replace(/^\.\//, '') ||
      text === link.path);
  const linkClass = pathLike
    ? [...new Set([...String(className || '').split(/\s+/), PATH_LINK_CLASS])].filter(Boolean).join(' ')
    : className;
  const label = pathLike ? (
    <>
      <LocalLinkIcon target={link} />
      {link.name}
      {link.suffix}
    </>
  ) : (
    children
  );
  // Paint the final icon and caption on the FIRST render. File verification
  // only enables clicking; missing/planned files keep the same inert geometry.
  // A healed explicit link may preview a path caption, never open its partial
  // destination. Empty/sanitized hrefs remain noninteractive as well.
  if (!raw || (verify && local && !link.verified)) {
    return (
      <span
        className={[linkClass, 'markdown-link-pending'].filter(Boolean).join(' ')}
        title={title || link.title}
        aria-disabled="true"
      >
        {label}
      </span>
    );
  }
  if (!external && !local)
    return (
      <a href={href} className={className} title={title}>
        {children}
      </a>
    );
  const openLocal = link.open;

  return (
    <a
      href={target}
      className={linkClass}
      title={local ? title || link.title : title}
      onMouseEnter={link.revealTitle}
      onPointerDown={local ? link.warmEditor : undefined}
      onAuxClick={local ? (event) => event.preventDefault() : undefined}
      onClick={(event) => {
        if (local) {
          // A local link must never navigate the renderer, including modified clicks.
          event.preventDefault();
          if (event.button === 0) void openLocal();
          return;
        }
        if (event.button !== undefined && event.button !== 0) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const fallback = () => {
          try {
            window.open(target, '_blank', 'noopener');
          } catch {
            /* popup blocked */
          }
        };
        const api = window.mixdogDesktop;
        if (api?.openExternal) void api.openExternal(target).catch(fallback);
        else fallback();
      }}
    >
      {label}
    </a>
  );
}
