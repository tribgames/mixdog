import { createContext, isValidElement, useContext, useState, type ReactNode } from "react";
import { showDesktopToast } from "./desktop-toasts";
import { SetiFileIcon } from "./SetiFileIcon";
import { errorMessageText } from "./ErrorNotice";
import { t } from "./i18n";
import { PATH_LINK_CLASS } from "./markdown-plugins";
import { isLocalMarkdownLink, projectRelativeFilePath } from "./markdown-url";
import { resolveLocalLink } from "./local-link-resolver";
import { localFileOpener, localLinkKind, parseLocalFileLocation } from "../shared/local-files";

function childrenText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenText).join("");
  if (isValidElement(node)) return childrenText((node.props as { children?: ReactNode }).children);
  return "";
}

// The owning conversation supplies its Project, not the globally active pane.
export const MarkdownProjectContext = createContext("");
/** Opens a Project file in Mixdog's editor at a line; the conversation host
 *  supplies it. Binary documents/media never come here — they go to the OS. */
export type MarkdownOpenFile = (project: string, rel: string, line?: number) => void;
export const MarkdownOpenFileContext = createContext<MarkdownOpenFile | null>(null);

function displayPath(project: string, rel: string, suffix: string): string {
  const separator = project.includes("\\") ? "\\" : "/";
  return `${project.replace(/[\\/]+$/, "")}${separator}${rel.replace(/\//g, separator)}${suffix}`;
}

export interface LocalLinkTarget {
  /** False for web URLs, anchors and unsupported schemes. */
  local: boolean;
  path: string;
  kind: "folder" | "file" | "unknown";
  /** Display name: file name, or `folder/`. */
  name: string;
  /** `:line[:column]` when the link carries one. */
  suffix: string;
  /** Full path for the tooltip; bare names fill it in after `revealTitle`. */
  title?: string;
  revealTitle?: () => void;
  open: () => Promise<void>;
}

/** One opening rule for every local mention (chat links, tool subjects):
 *  text files go to Mixdog's editor at their line, documents launch the OS
 *  app, folders open in the file manager. Each file uses its owning Project,
 *  which may differ from the conversation's current Project. */
export function useLocalLinkTarget(target: string): LocalLinkTarget {
  const projectPath = useContext(MarkdownProjectContext);
  const openFile = useContext(MarkdownOpenFileContext);
  const [resolved, setResolved] = useState({ key: "", title: "" });
  const resolutionKey = `${projectPath}\0${target}`;
  const resolvedTitle = resolved.key === resolutionKey ? resolved.title : "";
  const local = isLocalMarkdownLink(target);
  const location = parseLocalFileLocation(target);
  const kind = localLinkKind(location.path);
  const rel = local ? projectRelativeFilePath(projectPath, location.path) : null;
  // Only a relative mention without folders is a bare name; `C:/work/a.docx`
  // at the Project root is already exact.
  const bare = Boolean(rel && kind === "file" && !rel.includes("/")
    && !/^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(location.path));
  const suffix = location.line
    ? `:${location.line}${location.column ? `:${location.column}` : ""}` : "";
  const name = (location.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || location.path)
    + (kind === "folder" ? "/" : "");
  const title = resolvedTitle
    || (rel && !bare && projectPath ? displayPath(projectPath, rel, suffix) : undefined);

  const resolveTarget = () => resolveLocalLink(projectPath, location.path);
  const open = async () => {
    try {
      const { project, path: file } = await resolveTarget();
      setResolved({ key: resolutionKey, title: displayPath(project, file, suffix) });
      // A text file with an extension opens in the editor directly. Documents,
      // folders and extension-less names go through main, which launches the
      // OS app or file manager and hands text files back as 'editor'.
      if (kind !== "file" || localFileOpener(file) === "os") {
        const api = window.mixdogDesktop;
        if (!api?.openLocalFileLink) {
          throw new Error(t("Local file links can only be opened in the desktop app."));
        }
        // Main reads the href as a URL path: `report #1.docx` must travel as
        // `report%20%231.docx` or the `#` would start a fragment.
        const href = file.split("/").map(encodeURIComponent).join("/");
        if (await api.openLocalFileLink(project, href) !== "editor") return;
      }
      if (!openFile) throw new Error(t("Local file links can only be opened in the desktop app."));
      openFile(project, file, location.line);
    } catch (error) {
      showDesktopToast(t("Unable to open file: {{error}}", { error: errorMessageText(error) }), "error");
    }
  };
  // Resolve cross-Project paths on hover too; cache only for this exact
  // conversation cwd and link, never a preceding Project or target.
  const revealTitle = local && !resolvedTitle
    ? () => {
      resolveTarget()
        .then(({ project, path }) => setResolved({ key: resolutionKey, title: displayPath(project, path, suffix) }))
        .catch(() => {});
    }
    : undefined;
  return { local, path: location.path, kind, name, suffix, title, revealTitle, open };
}

/** The explorer's file glyph, so a file reads the same in chat as in the
 *  tree. Folders carry no glyph there either. */
export function LocalLinkIcon({ target }: { target: LocalLinkTarget }) {
  if (target.kind === "folder") return null;
  const name = target.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || target.path;
  return <SetiFileIcon name={name} />;
}

/** Tool-card subject that names a file: same rule and look as a chat link,
 *  as a span because it sits inside the card's header button. */
export function LocalPathMention({ path, line, children }: {
  path: string; line?: number; children: ReactNode;
}) {
  const link = useLocalLinkTarget(line ? `${path}:${line}` : path);
  if (!link.local) return <>{children}</>;
  return <span role="link" className="tool-path-link" title={link.title}
    onMouseEnter={link.revealTitle}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      void link.open();
    }}><LocalLinkIcon target={link} />{children}</span>;
}

export function MarkdownLink({ href, children, className, title }: {
  href?: string; children?: ReactNode; className?: string; title?: string;
}) {
  const raw = String(href || "").trim();
  const target = /^www\./i.test(raw) ? `https://${raw}` : raw;
  const external = /^https?:\/\//i.test(target);
  const link = useLocalLinkTarget(target);
  const local = link.local;
  if (!external && !local) return <a href={href} className={className} title={title}>{children}</a>;

  // Every file mention reads like an editor location — icon, file name and
  // `:line` — with the full path in the tooltip. Only a link whose text is an
  // actual caption (`[수정 요약](output/report.md)`) keeps that caption.
  const text = childrenText(children).trim();
  const pathLike = local && (String(className || "").split(/\s+/).includes(PATH_LINK_CLASS)
    || text === raw || text === link.path.replace(/^\.\//, "") || text === link.path);
  const linkClass = pathLike
    ? [...new Set([...String(className || "").split(/\s+/), PATH_LINK_CLASS])].filter(Boolean).join(" ")
    : className;
  const label = pathLike
    ? <><LocalLinkIcon target={link} />{link.name}{link.suffix}</>
    : children;
  const openLocal = link.open;

  return <a href={target} className={linkClass} title={local ? title || link.title : title}
    onMouseEnter={link.revealTitle}
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
        try { window.open(target, "_blank", "noopener"); } catch { /* popup blocked */ }
      };
      const api = window.mixdogDesktop;
      if (api?.openExternal) void api.openExternal(target).catch(fallback);
      else fallback();
    }}>{label}</a>;
}
