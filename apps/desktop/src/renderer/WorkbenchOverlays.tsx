import { Braces, Command as CommandIcon, FileText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  getEditorLanguageSnapshot,
  subscribeEditorLanguageStore,
  type EditorOutlineItem,
} from "./editor-language-store";
import { t } from "./i18n";
import { acquireModalLayer } from "./modal-layer";
import { acquireTitleBarDim } from "./titlebar-dim";

export type WorkbenchQuickAccessMode = "files" | "commands";

export interface WorkbenchCommand {
  id: string;
  category: string;
  label: string;
  shortcut?: string;
  enabled?: boolean;
  run(): void | Promise<void>;
}

export function parseQuickOpenQuery(value: string): { query: string; line?: number } {
  const trimmed = value.trim();
  const match = /^(.*?)(?::(\d+))?$/.exec(trimmed);
  const query = String(match?.[1] ?? trimmed).trim();
  const line = Number(match?.[2] || 0);
  return line > 0 ? { query, line } : { query };
}

function fuzzyScore(value: string, query: string): number | null {
  const haystack = value.toLocaleLowerCase();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return 0;
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return contiguous + (haystack.length - needle.length) / 1_000;
  let cursor = 0;
  let first = -1;
  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] !== needle[cursor]) continue;
    if (first < 0) first = index;
    cursor += 1;
  }
  return cursor === needle.length ? 1_000 + first + haystack.length / 1_000 : null;
}

type QuickAccessRow =
  | { key: string; kind: "file"; path: string }
  | { key: string; kind: "command"; command: WorkbenchCommand }
  | { key: string; kind: "symbol"; item: EditorOutlineItem }
  | { key: string; kind: "line"; line: number; relPath: string }
  | { key: string; kind: "project-symbol"; name: string; detail: string; relPath: string; line: number };

type ProjectSymbolRow = Extract<QuickAccessRow, { kind: "project-symbol" }>;

/** file:// URI → project-relative path (Mixdog is project-scoped; symbols
 *  outside the project root are dropped). */
function projectRelativePath(projectPath: string, uri: string): string | null {
  if (!/^file:/i.test(uri)) return null;
  try {
    let absolute = decodeURIComponent(new URL(uri).pathname).replace(/\\/g, "/");
    if (/^\/[A-Za-z]:/.test(absolute)) absolute = absolute.slice(1);
    const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!root
      || !absolute.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`)) return null;
    return absolute.slice(root.length + 1);
  } catch {
    return null;
  }
}

function projectSymbolRows(projectPath: string, result: unknown): ProjectSymbolRow[] {
  if (!Array.isArray(result)) return [];
  const rows: ProjectSymbolRow[] = [];
  for (const raw of result) {
    if (rows.length >= 200) break;
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const name = typeof record?.name === "string" ? record.name : "";
    const location = record?.location && typeof record.location === "object"
      ? record.location as Record<string, unknown>
      : null;
    const uri = typeof location?.uri === "string" ? location.uri : "";
    const relPath = name && uri ? projectRelativePath(projectPath, uri) : null;
    if (!relPath) continue;
    const range = location?.range && typeof location.range === "object"
      ? location.range as { start?: { line?: number } }
      : null;
    const container = typeof record?.containerName === "string" ? record.containerName : "";
    rows.push({
      key: `project-symbol:${uri}:${rows.length}`,
      kind: "project-symbol",
      name,
      detail: container || relPath,
      relPath,
      line: Math.max(1, Number(range?.start?.line ?? 0) + 1),
    });
  }
  return rows;
}

export function WorkbenchQuickAccess({
  mode,
  projectPath,
  recentFiles,
  commands,
  onOpenFile,
  onClose,
}: {
  mode: WorkbenchQuickAccessMode;
  projectPath: string;
  recentFiles: readonly string[];
  commands: readonly WorkbenchCommand[];
  onOpenFile(path: string, line?: number): void;
  onClose(): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [files, setFiles] = useState<string[]>(() => [...recentFiles]);
  const [projectSymbols, setProjectSymbols] = useState<ProjectSymbolRow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const searchGeneration = useRef(0);
  const commandMode = mode === "commands" || /^\s*>/.test(query);
  const commandQuery = query.replace(/^\s*>\s*/, "").trim();
  const fileQuery = parseQuickOpenQuery(query);
  // Quick-open prefixes: `@` finds document symbols and `:` goes to a line in
  // the active editor (`>` command routing already lives in commandMode).
  const language = useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorLanguageSnapshot,
    getEditorLanguageSnapshot,
  );
  const activeDocument = language.active
    && language.active.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
      === projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
    ? language.active
    : null;
  const symbolMode = !commandMode && /^\s*@/.test(query);
  const symbolQuery = query.replace(/^\s*@\s*/, "").trim();
  const lineMode = !commandMode && /^\s*:\s*\d*\s*$/.test(query);
  // `#` searches PROJECT symbols through the active document's language
  // server (LSP method name `workspace/symbol` is protocol-only).
  const projectSymbolMode = !commandMode && /^\s*#/.test(query);
  const projectSymbolQuery = query.replace(/^\s*#\s*/, "").trim();

  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.release();
      prior?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (projectSymbolMode) {
      const request = window.mixdogDesktop?.lspRequest;
      if (!activeDocument || !request) {
        setProjectSymbols([]);
        setLoading(false);
        setError("");
        return undefined;
      }
      setLoading(true);
      setError("");
      const timer = window.setTimeout(() => {
        void request({
          projectPath,
          relPath: activeDocument.relPath,
          languageId: activeDocument.languageId,
          method: "workspace/symbol",
          params: { query: projectSymbolQuery },
        }).then((response) => {
          if (searchGeneration.current !== generation) return;
          setProjectSymbols(projectSymbolRows(projectPath, response.result));
          setLoading(false);
          setError(response.available ? "" : response.detail || t("Project symbols are unavailable."));
        }).catch((reason) => {
          if (searchGeneration.current !== generation) return;
          setProjectSymbols([]);
          setLoading(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      }, 120);
      return () => window.clearTimeout(timer);
    }
    if (commandMode || symbolMode || lineMode) {
      setLoading(false);
      setError("");
      return undefined;
    }
    if (!fileQuery.query) {
      setFiles([...recentFiles]);
      setLoading(false);
      setError("");
      return undefined;
    }
    if (!projectPath || !window.mixdogDesktop?.searchProjectFiles) {
      setFiles([]);
      setLoading(false);
      setError(projectPath ? t("File search is unavailable.") : t("Open a project to search files."));
      return undefined;
    }
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      void window.mixdogDesktop?.searchProjectFiles?.(projectPath, fileQuery.query, 100)
        .then((paths) => {
          if (searchGeneration.current !== generation) return;
          setFiles(paths ?? []);
          setLoading(false);
        })
        .catch((reason) => {
          if (searchGeneration.current !== generation) return;
          setFiles([]);
          setLoading(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [activeDocument, commandMode, fileQuery.query, lineMode, projectPath,
    projectSymbolMode, projectSymbolQuery, recentFiles, symbolMode]);

  const rows = useMemo<QuickAccessRow[]>(() => {
    if (projectSymbolMode) return projectSymbols;
    if (symbolMode) {
      if (!activeDocument) return [];
      return language.outline
        .map((item) => ({ item, score: fuzzyScore(item.name, symbolQuery) }))
        .filter((entry): entry is { item: EditorOutlineItem; score: number } => entry.score !== null)
        .sort((left, right) => left.score - right.score || left.item.line - right.item.line)
        .map(({ item }) => ({ key: `symbol:${item.key}`, kind: "symbol" as const, item }));
    }
    if (lineMode) {
      return activeDocument && fileQuery.line
        ? [{
            key: `line:${fileQuery.line}`,
            kind: "line" as const,
            line: fileQuery.line,
            relPath: activeDocument.relPath,
          }]
        : [];
    }
    if (!commandMode) {
      return [...new Set(files)].map((path) => ({ key: `file:${path}`, kind: "file", path }));
    }
    return commands
      .map((command) => ({
        command,
        score: fuzzyScore(`${command.category}: ${command.label}`, commandQuery),
      }))
      .filter((entry): entry is { command: WorkbenchCommand; score: number } => entry.score !== null)
      .sort((left, right) => left.score - right.score || left.command.label.localeCompare(right.command.label))
      .map(({ command }) => ({ key: `command:${command.id}`, kind: "command", command }));
  }, [activeDocument, commandMode, commandQuery, commands, fileQuery.line, files,
    language.outline, lineMode, projectSymbolMode, projectSymbols, symbolMode, symbolQuery]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [commandMode, query]);
  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, rows.length - 1)));
  }, [rows.length]);

  const runRow = (row: QuickAccessRow | undefined) => {
    if (!row) return;
    if (row.kind === "command") {
      if (row.command.enabled === false) return;
      onClose();
      void Promise.resolve(row.command.run()).catch((reason) => {
        console.warn("Workbench command failed:", reason);
      });
      return;
    }
    if (row.kind === "symbol") {
      onClose();
      onOpenFile(row.item.relPath, row.item.line);
      return;
    }
    if (row.kind === "project-symbol") {
      onClose();
      onOpenFile(row.relPath, row.line);
      return;
    }
    if (row.kind === "line") {
      onClose();
      onOpenFile(row.relPath, row.line);
      return;
    }
    onClose();
    onOpenFile(row.path, fileQuery.line);
  };
  const selected = rows[selectedIndex];
  const listMessage = loading
    ? t("Searching…")
    : error || (commandMode
      ? t("No commands match.")
      : projectSymbolMode
        ? (activeDocument ? t("No project symbols match.") : t("Open a file to search project symbols."))
        : symbolMode
          ? (activeDocument ? t("No symbols match.") : t("Open a file to go to a symbol."))
          : lineMode
            ? (activeDocument ? t("Type a line number.") : t("Open a file to go to a line."))
            : fileQuery.query ? t("No files match.") : projectPath ? t("No recently opened files.") : t("Open a project to search files."));

  return createPortal(
    <div ref={surfaceRef} className="workbench-quick-access-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
      <section className="workbench-quick-access" role="dialog" aria-modal="true"
        aria-label={commandMode ? t("Command Palette") : t("Quick Open")}>
        <div className="workbench-quick-input">
          {commandMode
            ? <CommandIcon size={16} aria-hidden="true" />
            : <Search size={16} aria-hidden="true" />}
          <input ref={inputRef}
            aria-label={commandMode ? t("Command Palette") : t("Quick Open")}
            placeholder={commandMode
              ? t("Type the name of a command")
              : t("Search files by name (: line · @ file symbols · # project symbols)")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((current) => rows.length ? (current + 1) % rows.length : 0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) => rows.length ? (current - 1 + rows.length) % rows.length : 0);
              } else if (event.key === "Home") {
                event.preventDefault();
                setSelectedIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setSelectedIndex(Math.max(0, rows.length - 1));
              } else if (event.key === "PageDown") {
                event.preventDefault();
                setSelectedIndex((current) => Math.min(rows.length - 1, current + 10));
              } else if (event.key === "PageUp") {
                event.preventDefault();
                setSelectedIndex((current) => Math.max(0, current - 10));
              } else if (event.key === "Enter") {
                event.preventDefault();
                runRow(selected);
              }
            }} />
        </div>
        <div className="workbench-quick-results" role="listbox"
          aria-label={commandMode ? t("Commands") : t("Files")}>
          {rows.length ? rows.map((row, index) => {
            const active = index === selectedIndex;
            if (row.kind === "command") {
              return <button type="button" role="option" key={row.key}
                aria-selected={active} aria-disabled={row.command.enabled === false}
                className={active ? "active" : ""}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runRow(row)}>
                <CommandIcon size={14} aria-hidden="true" />
                <span><small>{row.command.category}</small>{row.command.label}</span>
                {row.command.shortcut && <kbd>{row.command.shortcut}</kbd>}
              </button>;
            }
            if (row.kind === "project-symbol") {
              return <button type="button" role="option" key={row.key}
                aria-selected={active} className={active ? "active" : ""}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runRow(row)}>
                <Braces size={14} aria-hidden="true" />
                <span><b>{row.name}</b><small>{row.detail}</small></span>
              </button>;
            }
            if (row.kind === "symbol") {
              return <button type="button" role="option" key={row.key}
                aria-selected={active} className={active ? "active" : ""}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runRow(row)}>
                <Braces size={14} aria-hidden="true" />
                <span><b>{row.item.name}</b>{row.item.detail && <small>{row.item.detail}</small>}</span>
                <kbd>{`Ln ${row.item.line}`}</kbd>
              </button>;
            }
            if (row.kind === "line") {
              return <button type="button" role="option" key={row.key}
                aria-selected={active} className={active ? "active" : ""}
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runRow(row)}>
                <Search size={14} aria-hidden="true" />
                <span>{t("Go to line {{line}}", { line: row.line })}</span>
              </button>;
            }
            const normalized = row.path.replace(/\\/g, "/");
            const split = normalized.lastIndexOf("/");
            const name = split >= 0 ? normalized.slice(split + 1) : normalized;
            const parent = split >= 0 ? normalized.slice(0, split) : "";
            return <button type="button" role="option" key={row.key}
              aria-selected={active} className={active ? "active" : ""}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runRow(row)}>
              <FileText size={14} aria-hidden="true" />
              <span><b>{name}</b>{parent && <small>{parent}</small>}</span>
            </button>;
          }) : <p role="status">{listMessage}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function UnsavedChangesDialog({
  title,
  busy,
  error,
  onSave,
  onDiscard,
  onCancel,
}: {
  title: string;
  busy: boolean;
  error: string;
  onSave(): void;
  onDiscard(): void;
  onCancel(): void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const layer = acquireModalLayer(shell ? [shell] : []);
    layer.attachSurface(surfaceRef.current);
    saveRef.current?.focus({ preventScroll: true });
    // The scrim cannot reach the NATIVE caption band; this claim dims it.
    const captionDim = acquireTitleBarDim();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!layer.isTop()) return;
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])",
      ) || []);
      if (!controls.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const current = controls.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.shiftKey
        ? (current <= 0 ? controls.length - 1 : current - 1)
        : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
      event.preventDefault();
      controls[next]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      layer.release();
      captionDim();
      prior?.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div ref={surfaceRef} className="settings-confirm-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}>
      <section ref={dialogRef} className="settings-confirm-dialog workbench-unsaved-dialog"
        role="alertdialog" aria-modal="true" aria-labelledby="workbench-unsaved-title"
        aria-describedby="workbench-unsaved-description" tabIndex={-1}>
        <header><h3 id="workbench-unsaved-title">{t("Save changes to {{title}}?", { title })}</h3></header>
        <p id="workbench-unsaved-description">
          {t("Your changes will be lost if you don’t save them.")}
        </p>
        {error && <p className="workbench-unsaved-error" role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={onCancel}>{t("Cancel")}</button>
          <button type="button" disabled={busy} onClick={onDiscard}>{t("Don’t Save")}</button>
          <button ref={saveRef} type="button" className="primary" disabled={busy}
            onClick={onSave}>{busy ? t("Saving…") : t("Save")}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
