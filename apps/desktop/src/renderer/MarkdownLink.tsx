import { createContext, useContext, type ReactNode } from "react";
import { showDesktopToast } from "./desktop-toasts";
import { t } from "./i18n";
import { isLocalMarkdownLink } from "./markdown-url";

// The owning conversation supplies its Project, not the globally active pane.
export const MarkdownProjectContext = createContext("");

export function MarkdownLink({ href, children, className, title }: {
  href?: string; children?: ReactNode; className?: string; title?: string;
}) {
  const projectPath = useContext(MarkdownProjectContext);
  const raw = String(href || "").trim();
  const target = /^www\./i.test(raw) ? `https://${raw}` : raw;
  const external = /^https?:\/\//i.test(target);
  const local = isLocalMarkdownLink(target);
  if (!external && !local) return <a href={href} className={className} title={title}>{children}</a>;

  const openLocal = async () => {
    try {
      const api = window.mixdogDesktop;
      if (!api?.openLocalFileLink) {
        throw new Error(t("Local file links can only be opened in the desktop app."));
      }
      if (!projectPath) throw new Error(t("The conversation's Project is unavailable."));
      await api.openLocalFileLink(projectPath, target);
    } catch (error) {
      showDesktopToast(t("Unable to open file: {{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }), "error");
    }
  };

  return <a href={target} className={className} title={title}
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
    }}>{children}</a>;
}
