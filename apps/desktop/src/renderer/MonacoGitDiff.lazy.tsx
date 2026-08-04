// Monaco DiffEditor surface for the git diff tab (VS Code diff parity):
// character-level inline highlights, margin revert arrows, and an editable
// modified side for working-tree diffs (Ctrl+S saves through the CAS write).
// Contents load here so the host pane stays patch-based for the text modes.
import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopTextFileEncoding } from "../shared/contract";
import { monaco } from "./monaco-setup";
import { ProgressSpinner } from "./ProgressSpinner";

function useMixdogMonacoTheme(): string {
  const [light, setLight] = useState(
    () => document.documentElement.dataset.mixdogTheme === "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setLight(root.dataset.mixdogTheme === "light"));
    observer.observe(root, { attributes: true, attributeFilter: ["data-mixdog-theme"] });
    return () => observer.disconnect();
  }, []);
  return light ? "mixdog-light" : "mixdog-dark";
}

export default function MonacoGitDiff({
  project,
  rel,
  source,
  hash,
  sideBySide,
  onSaved,
}: {
  project: string;
  rel: string;
  source: "staged" | "unstaged" | "commit";
  hash?: string;
  sideBySide: boolean;
  onSaved?(): void;
}) {
  const api = window.mixdogDesktop;
  const theme = useMixdogMonacoTheme();
  const [contents, setContents] = useState<{ original: string; modified: string } | null>(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  const baseline = useRef("");
  const encoding = useRef<DesktopTextFileEncoding | undefined>(undefined);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const editorRef = useRef<import("monaco-editor").editor.IStandaloneDiffEditor | null>(null);
  const editable = source === "unstaged";
  const load = useCallback(async () => {
    const request = ++epoch.current;
    setError("");
    try {
      const gitPath = rel.replace(/\\/g, "/");
      const readWorktree = async (): Promise<string | null> => {
        if (!api?.readProjectFile) return null;
        const file = await api.readProjectFile(project, rel);
        encoding.current = file.encoding;
        return file.binary || file.tooLarge ? null : file.content;
      };
      const [original, modified] = await Promise.all([
        api?.gitShowFile?.(
          project,
          source === "commit" ? `${String(hash || "")}^` : source === "staged" ? "HEAD" : ":0",
          gitPath,
        ) ?? null,
        source === "commit"
          ? api?.gitShowFile?.(project, String(hash || ""), gitPath) ?? null
          : source === "staged"
            ? api?.gitShowFile?.(project, ":0", gitPath) ?? null
            : readWorktree(),
      ]);
      if (request !== epoch.current) return;
      baseline.current = modified ?? "";
      setContents({ original: original ?? "", modified: modified ?? "" });
      setDirty(false);
    } catch (reason) {
      if (request !== epoch.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api, hash, project, rel, source]);
  useEffect(() => {
    setContents(null);
    void load();
  }, [load]);
  // Stage/unstage/save actions elsewhere refresh this surface, but never
  // over live edits.
  useEffect(() => {
    const onChanged = () => {
      if (!dirtyRef.current) void load();
    };
    window.addEventListener("mixdog:git-changed", onChanged);
    return () => window.removeEventListener("mixdog:git-changed", onChanged);
  }, [load]);
  const save = useCallback(async () => {
    const model = editorRef.current?.getModel()?.modified;
    if (!api?.writeProjectFile || !model || !editable) return;
    const content = model.getValue();
    setSaving(true);
    setError("");
    try {
      await api.writeProjectFile(project, rel, content, baseline.current, undefined, encoding.current);
      baseline.current = content;
      setDirty(false);
      window.dispatchEvent(new Event("mixdog:git-changed"));
      onSaved?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }, [api, editable, onSaved, project, rel]);
  const saveRef = useRef(save);
  saveRef.current = save;
  // A failed save/reload must NEVER unmount the editor — that would dispose
  // the models and silently drop live edits. Full-screen states are reserved
  // for before the first successful load.
  if (contents === null) {
    return error
      ? <p className="workspace-git-diff-state" role="alert">{error}</p>
      : <p className="workspace-git-diff-state">
          <ProgressSpinner size={16} /> Loading diff…
        </p>;
  }
  return <div className="workspace-git-diff-editor">
    {(error || (editable && dirty)) && <div className="workspace-git-diff-editor-bar">
      <span role={error ? "alert" : undefined}>{error || "Unsaved changes"}</span>
      {editable && dirty && <button type="button" disabled={saving}
        onClick={() => { void saveRef.current(); }}>
        {saving ? "Saving…" : "Save (Ctrl+S)"}
      </button>}
    </div>}
    <DiffEditor
      original={contents.original}
      modified={contents.modified}
      originalModelPath={`mixdog-diff://original/${encodeURIComponent(project)}/${source}/${rel.replace(/\\/g, "/")}`}
      modifiedModelPath={`mixdog-diff://modified/${encodeURIComponent(project)}/${source}/${rel.replace(/\\/g, "/")}`}
      theme={theme}
      options={{
        renderSideBySide: sideBySide,
        readOnly: !editable,
        originalEditable: false,
        renderMarginRevertIcon: editable,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
      }}
      onMount={(editor) => {
        editorRef.current = editor;
        const modified = editor.getModifiedEditor();
        modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void saveRef.current();
        });
        modified.onDidChangeModelContent(() => {
          setDirty(modified.getValue() !== baseline.current);
        });
      }}
    />
  </div>;
}
