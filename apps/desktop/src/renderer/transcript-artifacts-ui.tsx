import { FileText, FolderOpen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptItem } from "./desktop-types";
import { showDesktopToast } from "./desktop-toasts";
import { t } from "./i18n";
import { MarkdownLink } from "./MarkdownLink";
import { MxIcon } from "./MxIcon";
import { mediaUrl } from "./studio-support";
import { requestTranscriptRowMeasure } from "./transcript-measure";
import { transcriptArtifacts, type TranscriptArtifact } from "./transcript-artifacts";

function GeneratedMedia({ artifact }: { artifact: TranscriptArtifact }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const api = window.mixdogDesktop;
  const id = artifact.assetId!;
  const original = mediaUrl(api, id, "original");
  const preview = mediaUrl(api, id, artifact.kind === "video" ? "thumb" : "display");
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
  }, [expanded]);
  const open = async (folder = false) => {
    try {
      const action = folder ? api?.openMediaFolder : api?.openMediaAsset;
      if (!action) throw new Error(t("Local file links can only be opened in the desktop app."));
      await action(id);
    } catch (error) {
      showDesktopToast(t("Unable to open file: {{error}}", {
        error: error instanceof Error ? error.message : String(error),
      }), "error");
    }
  };
  return <figure className="transcript-artifact-media">
    {!failed && original && (artifact.kind === "video"
      ? <video src={original} poster={preview || undefined} controls preload="none"
        playsInline onError={() => setFailed(true)} aria-label={artifact.name} />
      : <button type="button" className="transcript-artifact-image" aria-label={t("Open image")}
        onClick={() => setExpanded(true)}>
        <img src={preview || original} alt={artifact.name} loading="lazy"
          onError={(event) => {
            if (event.currentTarget.src !== original) event.currentTarget.src = original;
            else setFailed(true);
          }} />
      </button>)}
    <figcaption>
      <span title={artifact.path || artifact.name}>{artifact.name}</span>
      {/* Same icon-only action grammar as the response copy control: transparent
          icon-button + tooltip, never a native grey text button. */}
      <button type="button" className="icon-button" aria-label={t("Open file")}
        data-tooltip={t("Open file")} onClick={() => void open()}>
        <MxIcon name="open-file" size={14} />
      </button>
      {api?.openMediaFolder && <button type="button" className="icon-button" aria-label={t("Open Folder")}
        data-tooltip={t("Open Folder")} onClick={() => void open(true)}>
        <FolderOpen size={14} aria-hidden="true" />
      </button>}
    </figcaption>
    {expanded && <dialog ref={dialog} className="transcript-artifact-preview"
      aria-label={t("Open image")} onClose={() => setExpanded(false)}
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <button type="button" className="icon-button" aria-label={t("Close preview")}
        data-tooltip={t("Close preview")} data-tooltip-side="left" onClick={() => dialog.current?.close()}>
        <X size={16} aria-hidden="true" />
      </button>
      <img src={original} alt={artifact.name} />
    </dialog>}
  </figure>;
}

export function TranscriptArtifacts({ items }: { items: readonly TranscriptItem[] }) {
  const artifacts = useMemo(() => transcriptArtifacts(items), [items]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    requestTranscriptRowMeasure(root.current);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => requestTranscriptRowMeasure(root.current));
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [artifacts]);
  if (!artifacts.length) return null;
  return <div ref={root} className="transcript-artifacts">
    {artifacts.map((artifact) => artifact.assetId
      ? <GeneratedMedia key={artifact.key} artifact={artifact} />
      : <MarkdownLink key={artifact.key} className="transcript-artifact-file" title={artifact.path}
        href={artifact.path.replace(/\\/g, "/").split("/").map((part, index) =>
          index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)).join("/")}>
        <FileText size={16} aria-hidden="true" />
        <span>{artifact.name}</span>
        <small>{t("Open file")}</small>
      </MarkdownLink>)}
  </div>;
}
