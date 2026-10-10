import { createContext, isValidElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { showDesktopToast } from './desktop-toasts';
import { LinkKindIcon } from './link-kind-icon';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { localPathMentionHref, PATH_LINK_CLASS } from './markdown-plugins';
import { isLocalMarkdownLink, localMarkdownPath, projectRelativeFilePath } from './markdown-url';
import { prefetchEditorPane, scheduleEditorPanePrefetch } from './lazy-widgets';
import { resolveLocalLink, verifyLocalLink, type ResolvedLocalLink } from './local-link-resolver';
import { isLocalWebPage, localLinkKind, parseLocalFileLocation } from '../shared/local-files';
import { documentPreviewFormatForPath, editorFileOpener } from '../shared/file-preview';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import { copyTextToClipboard } from './text-format';
import { openEditorFileExternally } from './editor-external-file';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { linkOpenTarget } from './link-open-target';
import { openConfirmedFile } from './file-launch-confirmation';
import { openSandboxedPagePreview } from './sandboxed-page-preview';

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
/** The owning conversation's session ('' for a draft): web pages open in its
 *  browser pane and code blocks run in its terminal. */
export const MarkdownSessionContext = createContext('');
/** Project-relative folder of the document being rendered ('' for chat):
 *  relative links and images resolve against it instead of the Project root. */
export const MarkdownDocumentDirContext = createContext('');

/** A relative local path re-based onto the document's folder; absolute paths
 *  and chat (no folder) pass through unchanged. */
export function documentRelativePath(directory: string, path: string): string {
  if (!directory || directory === '.' || !path) return path;
  const decoded = localMarkdownPath(path);
  if (!decoded || /^[a-z]:\//i.test(decoded) || decoded.startsWith('/')) return path;
  // The authored text stays percent-encoded and the document folder is
  // encoded to match, so the resolver's single decode sees `%23` and `%25`
  // as characters, not as a fragment or an escape.
  const parts = directory
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .map(encodeURIComponent);
  for (const part of path.trim().split(/[?#]/, 1)[0].replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part !== '..') {
      parts.push(part);
    } else if (parts.length) {
      parts.pop();
    } else {
      return path;
    }
  }
  return parts.join('/');
}
/** Opens a Project file in Mixdog's editor at a line; the conversation host
 *  supplies it. Binary documents/media never come here — they go to the OS. */
type MarkdownOpenFile = (
  project: string,
  rel: string,
  line?: number,
  accessToken?: string,
  /** Only passed when the link carried `:line:column`. */
  column?: number
) => void;
export const MarkdownOpenFileContext = createContext<MarkdownOpenFile | null>(null);
/** Reveals a Project folder in the conversation pane's side-dock Files tree;
 *  absent where there is no dock (phone/remote), so folders keep the OS file
 *  manager. */
export const MarkdownOpenFolderContext = createContext<((project: string, rel: string) => void) | null>(null);

/** A directory the dock can reveal: a trailing separator names one, an
 *  extension-less name is probed by listing it (a file fails to list). */
async function isProjectFolder(project: string, rel: string, kind: 'folder' | 'file' | 'unknown'): Promise<boolean> {
  if (kind === 'folder') return true;
  if (kind !== 'unknown') return false;
  try {
    await window.mixdogDesktop?.listProjectDir?.(project, rel);
    return true;
  } catch {
    return false;
  }
}

/** An absolute folder as the deepest registered Project containing it plus
 *  its path inside that Project; null when no registered Project owns it (the
 *  dock tree can only list registered Projects). */
async function owningProjectFolder(folder: string): Promise<{ project: string; rel: string } | null> {
  const projects = (await window.mixdogDesktop?.listProjects?.()) || [];
  let owner: { project: string; rel: string } | null = null;
  for (const { path } of projects) {
    const rel = projectRelativeFilePath(path, folder);
    if (rel === null || rel.startsWith('..')) continue;
    if (!owner || path.length > owner.project.length) owner = { project: path, rel };
  }
  return owner;
}

function reportOpenFailure(error: unknown) {
  showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
}

/** Open a web page (a web URL or a served local page) where linkOpenTarget
 *  says: the session's browser pane, or the system browser. Rejects when the
 *  system browser cannot be opened. */
async function openWebLink(sessionId: string | undefined, url: string, external?: boolean): Promise<void> {
  if (linkOpenTarget({ sessionId, paneAvailable: browserPageRequestsAvailable(), external }) === 'pane') {
    requestBrowserPage(sessionId as string, url);
    return;
  }
  const api = window.mixdogDesktop;
  if (api?.openExternal) {
    await api.openExternal(url);
    return;
  }
  // Only a surface without the desktop bridge opens a tab itself.
  window.open(url, '_blank', 'noopener');
}

function displayPath(project: string, rel: string, suffix: string): string {
  const separator = project.includes('\\') ? '\\' : '/';
  return `${project.replace(/[\\/]+$/, '')}${separator}${rel.replace(/\//g, separator)}${suffix}`;
}

interface LocalLinkTarget {
  /** False for web URLs, anchors and unsupported schemes. */
  local: boolean;
  /** True only after an automatic mention's resolved target has been statted. */
  verified: boolean;
  /** True once an automatic mention's verification has failed. */
  missing: boolean;
  /** Why the last verification failed (tooltip of the plain-text fallback). */
  missingReason: string;
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
  /** Press intent, for surfaces that never hover: start the editor chunk
   *  before the click so the click itself no longer pays for it. */
  onPointerDown: (event: LinkPress) => void;
  onPointerUp: (event: LinkPress) => void;
  onPointerCancel: () => void;
  /** Mouse hover / keyboard focus on a convertible document link. */
  prefetchDocument?: () => void;
  /** `external` sends a local web page to the system browser instead of the pane. */
  open: (external?: boolean) => Promise<void>;
  /** A local HTML page that opens as a served web page (can go external). */
  webPage: boolean;
  openDefault: () => Promise<void>;
  reveal: () => Promise<void>;
  copyPath: () => Promise<void>;
}

const DOCUMENT_PREFETCH_WINDOW_MS = 30_000;
const documentPrefetches = new Map<string, number>();

/** True once per (project, path) per window, so hovering back and forth over
 *  one link starts a single conversion. */
function claimDocumentPrefetch(project: string, file: string): boolean {
  const now = Date.now();
  for (const [key, at] of documentPrefetches) {
    if (now - at >= DOCUMENT_PREFETCH_WINDOW_MS) documentPrefetches.delete(key);
  }
  const key = `${project}\0${file}`;
  if (documentPrefetches.has(key)) return false;
  documentPrefetches.set(key, now);
  return true;
}

/** Focus from the keyboard, not from the press of a mouse or finger. */
function focusIsKeyboard(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

type LinkPress = { pointerType: string; pointerId: number; clientX: number; clientY: number };
const TAP_SLOP_PX = 10;
/** Backoff of a failed mention lookup; the first step outlasts the resolver's
 *  3s cache of a miss, so each retry asks the file service again. */
const LINK_VERIFY_RETRY_MS = [3_500, 10_000, 30_000];

/** Which press is an open intent. A mouse press is one. A touch or pen press
 *  usually starts a scroll, and evaluating the editor's 4 MB chunk under it
 *  is a ~280 ms long task mid-swipe on a phone, so those count only as a tap:
 *  released where they began (a scroll ends in pointercancel or elsewhere). */
export function createLinkPressIntent() {
  let touch: LinkPress | null = null;
  return {
    /** True when the press itself is the intent. */
    down(event: LinkPress): boolean {
      touch = null;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return true;
      const { pointerType, pointerId, clientX, clientY } = event;
      touch = { pointerType, pointerId, clientX, clientY };
      return false;
    },
    /** True when a touch or pen press ends as a tap. */
    up(event: LinkPress): boolean {
      const start = touch;
      touch = null;
      return Boolean(
        start &&
          start.pointerId === event.pointerId &&
          Math.abs(event.clientX - start.clientX) <= TAP_SLOP_PX &&
          Math.abs(event.clientY - start.clientY) <= TAP_SLOP_PX
      );
    },
    cancel(): void {
      touch = null;
    },
  };
}

/** One opening rule for every local mention (chat links, tool subjects):
 *  text files go to Mixdog's editor at their line, documents launch the OS
 *  app, folders open in the file manager. Each file uses its owning Project,
 *  which may differ from the conversation's current Project. */
function useLocalLinkTarget(target: string, verify = false): LocalLinkTarget {
  const projectPath = useContext(MarkdownProjectContext);
  const sessionId = useContext(MarkdownSessionContext);
  const openFile = useContext(MarkdownOpenFileContext);
  const openFolder = useContext(MarkdownOpenFolderContext);
  const documentDir = useContext(MarkdownDocumentDirContext);
  const [resolved, setResolved] = useState<{ key: string; title: string; target: ResolvedLocalLink | null }>({
    key: '',
    title: '',
    target: null,
  });
  const [verifiedKey, setVerifiedKey] = useState('');
  const [missingKey, setMissingKey] = useState('');
  const [missingReason, setMissingReason] = useState('');
  // Failed verifications retry on a backoff: one transient file-service
  // failure must not leave a real file as plain text for the whole session.
  const [retry, setRetry] = useState({ key: '', attempt: 0 });
  const [press] = useState(createLinkPressIntent);
  const resolutionKey = `${projectPath}\0${documentDir}\0${target}`;
  const resolvedTitle = resolved.key === resolutionKey ? resolved.title : '';
  const resolvedTarget = resolved.key === resolutionKey ? resolved.target : null;
  const local = isLocalMarkdownLink(target);
  const authored = parseLocalFileLocation(target);
  const location = local ? { ...authored, path: documentRelativePath(documentDir, authored.path) } : authored;
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
  // Verification looks only in the conversation's Project (a bare name found
  // in another Project stays text): searching every registered Project per
  // rendered mention would flood the file service. Repeated mentions of one
  // name share a single verification.
  const attempt = retry.key === resolutionKey ? retry.attempt : 0;
  useEffect(() => {
    if (!verify || !local) return;
    // A retry keeps the current (missing) paint until it has an answer.
    if (attempt === 0) {
      setVerifiedKey('');
      setMissingKey('');
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    verifyLocalLink(projectPath, location.path)
      .then((match) => {
        if (!active) return;
        setResolved({
          key: resolutionKey,
          title: displayPath(match.project, match.path, suffix),
          target: match,
        });
        setMissingKey('');
        setVerifiedKey(resolutionKey);
      })
      // Missing, ambiguous, inaccessible or unverified mentions remain text
      // (the reason is the tooltip) and are looked up again on a backoff.
      .catch((error: unknown) => {
        if (!active) return;
        setMissingReason(errorMessageText(error));
        setMissingKey(resolutionKey);
        const delay = LINK_VERIFY_RETRY_MS[attempt];
        if (delay !== undefined) {
          timer = setTimeout(() => setRetry({ key: resolutionKey, attempt: attempt + 1 }), delay);
        }
      });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [verify, local, projectPath, location.path, resolutionKey, suffix, attempt]);

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
  // A web page link shows the page; naming a line asks for its source instead.
  const pageLink = isLocalWebPage(location.path) && !location.line;
  const editorTarget = local && kind === 'file' && editorFileOpener(location.path) === 'editor' && !pageLink;
  const warmEditor = () => {
    if (editorTarget) void prefetchEditorPane().catch(() => {});
  };
  // Hover or keyboard focus on a document link: start its conversion now so
  // the click finds the pages ready. Errors are the click's to report.
  const documentTarget = local && kind === 'file' && Boolean(documentPreviewFormatForPath(location.path));
  const prefetchDocument = documentTarget
    ? () => {
        resolveTarget()
          .then(({ project, path: file, accessToken, directory }) => {
            if (directory || !documentPreviewFormatForPath(file)) return;
            const reader = window.mixdogDesktop?.previewDocumentPages;
            if (!reader || !claimDocumentPrefetch(project, file)) return;
            return reader(project, file, accessToken, { pages: [1] });
          })
          .catch(() => {});
      }
    : undefined;
  const webPage = local && pageLink && typeof window !== 'undefined' && Boolean(window.mixdogDesktop?.localPageUrl);
  const open = async (external?: boolean) => {
    warmEditor();
    try {
      const { project, path: file, accessToken, directory } = await resolveTarget();
      // A web page opens in the session's browser pane from a loopback address
      // main serves; with no pane to reveal (a draft) the system browser takes
      // the same address. Without the server (a paired phone) it stays source.
      const pageUrl = window.mixdogDesktop?.localPageUrl;
      if (!directory && pageLink && pageUrl) {
        const url = await pageUrl(project, file, accessToken);
        await openWebLink(sessionId, url, external);
        return;
      }
      // A paired browser cannot reach the host's loopback server: the page
      // arrives as a self-contained document for a sandboxed frame instead.
      const pageSource = window.mixdogDesktop?.localPageSource;
      if (!directory && pageLink && pageSource) {
        openSandboxedPagePreview(await pageSource(project, file, accessToken), file);
        return;
      }
      // A Project folder opens beside the conversation as the dock's Files
      // tree with the folder revealed; folders outside any Project (or behind
      // an access token) keep the file manager.
      if (openFolder && !accessToken) {
        let folder: Awaited<ReturnType<typeof owningProjectFolder>> = null;
        if (directory) folder = await owningProjectFolder(project);
        else if (await isProjectFolder(project, file, kind)) folder = { project, rel: file };
        if (folder) {
          openFolder(folder.project, folder.rel);
          return;
        }
      }
      // A text file with an extension opens in the editor directly. Documents,
      // folders and extension-less names go through main, which launches the
      // OS app or file manager and hands text files back as 'editor'.
      if (directory || kind !== 'file' || editorFileOpener(file) === 'os') {
        const api = window.mixdogDesktop;
        if (!api?.openLocalFileLink) {
          throw new Error(t('Local file links can only be opened in the desktop app.'));
        }
        // Main reads the href as a URL path: `report #1.docx` must travel as
        // `report%20%231.docx` or the `#` would start a fragment.
        const href = file.split('/').map(encodeURIComponent).join('/');
        const opened = await openConfirmedFile((confirmedPath) =>
          confirmedPath ? api.openLocalFileLink!(project, href, confirmedPath) : api.openLocalFileLink!(project, href)
        );
        if (opened !== 'editor') return;
      }
      if (!openFile) throw new Error(t('Local file links can only be opened in the desktop app.'));
      if (location.line && location.column) openFile(project, file, location.line, accessToken, location.column);
      else if (accessToken) openFile(project, file, location.line, accessToken);
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
  // Explicit external actions for the right-click menu. Each re-resolves the
  // link, then goes through the same validated IPC as the editor's own buttons
  // (project boundary, realpath and access token are checked in main).
  const openDefault = async () => {
    try {
      const { project, path: file, accessToken } = await resolveTarget();
      await openEditorFileExternally(project, file, accessToken);
    } catch (error) {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    }
  };
  const reveal = async () => {
    try {
      const { project, path: file, accessToken } = await resolveTarget();
      const api = window.mixdogDesktop;
      if (!api?.revealFile) throw new Error(t('Desktop file access is unavailable.'));
      await api.revealFile(project, file, accessToken);
    } catch (error) {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    }
  };
  const copyPath = async () => {
    try {
      const { project, path: file } = await resolveTarget();
      await copyTextToClipboard(displayPath(project, file, ''));
    } catch (error) {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    }
  };
  return {
    openDefault,
    reveal,
    copyPath,
    webPage,
    local,
    verified: verifiedKey === resolutionKey,
    missing: missingKey === resolutionKey,
    missingReason,
    path: authored.path,
    kind,
    name,
    suffix,
    title,
    revealTitle,
    prefetchDocument,
    onPointerDown: (event) => {
      if (press.down(event)) warmEditor();
    },
    onPointerUp: (event) => {
      if (press.up(event)) warmEditor();
    },
    onPointerCancel: press.cancel,
    open,
  };
}

/** The explorer's file glyph, so a file reads the same in chat as in the
 *  tree; folders get the folder glyph. */
function LocalLinkIcon({ target }: { target: LocalLinkTarget }) {
  return <LinkKindIcon kind={target.kind === 'folder' ? 'folder' : 'file'} name={target.name} />;
}

/** Tool-card subject that names a file: same rule and look as a chat link,
 *  as its own focusable button (callers keep it out of the header's
 *  disclosure button). Enter/Space open it; its events never reach a
 *  disclosure around it. */
export function LocalPathMention({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const link = useLocalLinkTarget(line ? `${path}:${line}` : path);
  if (!link.local) return <>{children}</>;
  return (
    <button
      type="button"
      className="tool-path-link"
      title={link.title}
      onMouseEnter={link.revealTitle}
      onPointerDown={(event) => {
        event.stopPropagation();
        link.onPointerDown(event);
      }}
      onPointerUp={link.onPointerUp}
      onPointerCancel={link.onPointerCancel}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void link.open();
      }}
    >
      <LocalLinkIcon target={link} />
      {children}
    </button>
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
  const sessionId = useContext(MarkdownSessionContext);
  const local = link.local;
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const openWebLinkExternal = () => void openWebLink(sessionId, target, true).catch(reportOpenFailure);
  const copyLink = async () => {
    try {
      await copyTextToClipboard(target);
    } catch (error) {
      reportOpenFailure(error);
    }
  };
  const openMenu = (point: { x: number; y: number }) => {
    if (!local) {
      setMenu({
        label: target,
        ...point,
        items: [
          { id: 'open-browser', label: t('Open in browser'), onSelect: () => openWebLinkExternal() },
          { id: 'copy-link', label: t('Copy link'), onSelect: () => void copyLink() },
        ],
      });
      return;
    }
    const external = !isRemoteHostRenderer();
    setMenu({
      label: link.name,
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => void link.open() },
        ...(link.webPage
          ? [{ id: 'open-browser', label: t('Open in browser'), onSelect: () => void link.open(true) }]
          : []),
        ...(external
          ? [
              { id: 'open-default', label: t('Open in default app'), onSelect: () => void link.openDefault() },
              { id: 'reveal', label: t('Reveal in Explorer'), onSelect: () => void link.reveal() },
            ]
          : []),
        { id: 'copy-path', label: t('Copy path'), onSelect: () => void link.copyPath(), separatorBefore: true },
      ],
    });
  };
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
  let label: ReactNode = children;
  if (pathLike) {
    label = (
      <>
        <LocalLinkIcon target={link} />
        {link.name}
        {link.suffix}
      </>
    );
  } else if (local) {
    label = (
      <>
        <LocalLinkIcon target={link} />
        {children}
      </>
    );
  } else if (external) {
    label = (
      <>
        <LinkKindIcon kind="external" />
        {children}
      </>
    );
  }
  // An automatic mention whose lookup failed names no file the app can open:
  // it falls back to its original text, with no icon, link ink or click.
  if (verify && local && link.missing)
    return (
      <span className="markdown-path-missing" title={link.missingReason || undefined}>
        {children}
      </span>
    );
  // Paint the final icon and caption on the FIRST render. File verification
  // only enables clicking; a mention still being verified keeps the same inert
  // geometry. A healed explicit link may preview a path caption, never open its
  // partial destination. Empty/sanitized hrefs remain noninteractive as well.
  if (!raw || (verify && local && !link.verified)) {
    return (
      <span
        className={[linkClass, 'markdown-link-pending'].filter(Boolean).join(' ')}
        title={title || link.title}
        aria-disabled="true"
      >
        {label}
        {/* Session entry waits for the lookup: a mention that turns out
            missing would otherwise swap its look in front of the reader
            (user: 세션 재진입 시 링크 폰트가 바뀌면서 튄다). */}
        {verify && local && <span hidden data-transcript-pending />}
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
    <>
      {menu && <ScmContextMenu state={menu} onClose={() => setMenu(null)} />}
      <a
        href={target}
        className={linkClass}
        title={local ? title || link.title : title}
        onMouseEnter={link.revealTitle}
        onPointerEnter={
          link.prefetchDocument
            ? (event) => {
                if (event.pointerType === 'mouse') link.prefetchDocument?.();
              }
            : undefined
        }
        onFocus={
          link.prefetchDocument
            ? (event) => {
                if (focusIsKeyboard(event.currentTarget)) link.prefetchDocument?.();
              }
            : undefined
        }
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(pointerMenuPoint(event));
        }}
        onKeyDown={(event) => {
          if (!isContextMenuKey(event)) return;
          event.preventDefault();
          openMenu(elementMenuPoint(event.currentTarget));
        }}
        onPointerDown={local ? link.onPointerDown : undefined}
        onPointerUp={local ? link.onPointerUp : undefined}
        onPointerCancel={local ? link.onPointerCancel : undefined}
        onAuxClick={(event) => {
          // Never a renderer navigation or Electron window; middle click asks
          // for the system browser on web links and local web pages.
          event.preventDefault();
          if (event.button !== 1) return;
          if (local) {
            if (link.webPage) void openLocal(true);
          } else openWebLinkExternal();
        }}
        onClick={(event) => {
          const asksExternal = event.ctrlKey || event.metaKey;
          if (local) {
            // A local link must never navigate the renderer, including modified clicks.
            event.preventDefault();
            if (event.button === 0) void openLocal(asksExternal);
            return;
          }
          if (event.button !== undefined && event.button !== 0) return;
          if (asksExternal) {
            event.preventDefault();
            openWebLinkExternal();
            return;
          }
          if (event.shiftKey || event.altKey) return;
          event.preventDefault();
          void openWebLink(sessionId, target).catch(reportOpenFailure);
        }}
      >
        {label}
      </a>
    </>
  );
}
