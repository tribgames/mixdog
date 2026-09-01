import {
  Braces,
  ChevronLeft,
  ChevronRight,
  CircleX,
  File as FileIcon,
  Folder,
  FolderOpen,
  Save,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMobileBack } from "./mobile-back";
import { type EditorFileLoad } from "./editor-file-loader";
import { type EditorOutlineItem } from "./editor-language-store";
import { normalizedFilePath } from "./editor-lsp-conversion";
import { t } from "./i18n";
import {
  breadcrumbPickerAnchor,
  type BreadcrumbFileItem,
  type BreadcrumbPickerAnchor,
  type BreadcrumbPickerState,
  type FilePreview,
} from "./editor-pane-model";
import { ProgressSpinner } from "./ProgressSpinner";

export function EditorBreadcrumbs({
  projectPath,
  relPath,
  accessToken,
  load,
  preview,
  dirty,
  saving,
  reverting,
  cursorLine,
  outline,
  problemStatus,
  onSave,
  onRevert,
  onShowProblems,
  onOpenAt,
  onFocusEditor,
  onRevealSymbol,
}: {
  projectPath: string;
  relPath: string;
  accessToken?: string;
  load: EditorFileLoad | null;
  preview: FilePreview | null;
  dirty: boolean;
  saving: boolean;
  reverting: boolean;
  cursorLine: number;
  outline: EditorOutlineItem[];
  problemStatus: { errors: number; warnings: number };
  onSave(): void;
  onRevert(): void;
  onShowProblems(): void;
  onOpenAt?(relPath: string, line: number): void;
  onFocusEditor(): void;
  onRevealSymbol(item: EditorOutlineItem): void;
}) {
  const api = window.mixdogDesktop;
  const [picker, setPicker] = useState<BreadcrumbPickerState | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const pickerGeneration = useRef(0);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const segments = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const byLevel = new Map<number, EditorOutlineItem>();
  const containing = outline
    .filter((item) => item.line <= cursorLine && (item.endLine ?? item.line) >= cursorLine)
    .sort((left, right) => left.level - right.level || left.line - right.line);
  for (const item of containing) byLevel.set(item.level, item);
  const symbols = [...byLevel.values()];
  const symbol = symbols[symbols.length - 1];
  const editable = Boolean(load && !preview && !load.binary && !load.tooLarge);

  const closePicker = useCallback((restoreFocus = false) => {
    const sourceIndex = picker?.anchor.sourceIndex ?? focusIndex;
    setPicker(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => buttonRefs.current[sourceIndex]?.focus());
    }
  }, [focusIndex, picker?.anchor.sourceIndex]);
  useMobileBack(Boolean(picker), () => closePicker(true));

  const showFiles = useCallback((
    anchor: BreadcrumbPickerAnchor,
    directory: string,
    selectedRelPath: string,
  ) => {
    const list = api?.listProjectDir;
    if (!list || accessToken) return;
    const generation = ++pickerGeneration.current;
    setPicker({
      kind: "files",
      anchor,
      directory,
      selectedRelPath,
      rows: [],
      activeIndex: 0,
      loading: true,
      error: "",
    });
    void list(projectPath, directory)
      .then((entries) => {
        if (generation !== pickerGeneration.current) return;
        const rows = entries.map((entry) => ({
          ...entry,
          relPath: [directory, entry.name].filter(Boolean).join("/"),
        }));
        const selectedIndex = Math.max(0, rows.findIndex((row) =>
          normalizedFilePath(row.relPath).toLocaleLowerCase()
            === normalizedFilePath(selectedRelPath).toLocaleLowerCase()));
        setPicker((current) => current?.kind === "files"
          ? { ...current, rows, activeIndex: selectedIndex, loading: false, error: "" }
          : current);
      })
      .catch((reason) => {
        if (generation !== pickerGeneration.current) return;
        setPicker((current) => current?.kind === "files"
          ? {
              ...current,
              rows: [],
              activeIndex: 0,
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason),
            }
          : current);
      });
  }, [accessToken, api, projectPath]);

  const openPath = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    index: number,
  ) => {
    setFocusIndex(index);
    const anchor = breadcrumbPickerAnchor(event.currentTarget, index);
    const isFile = index === segments.length - 1;
    const directory = isFile
      ? segments.slice(0, -1).join("/")
      : segments.slice(0, index + 1).join("/");
    const selectedRelPath = isFile
      ? segments.join("/")
      : segments.slice(0, index + 2).join("/");
    showFiles(anchor, directory, selectedRelPath);
  }, [segments, showFiles]);

  const openSymbol = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    sourceIndex: number,
    selected?: EditorOutlineItem,
  ) => {
    setFocusIndex(sourceIndex);
    const rows = outline.slice().sort((left, right) =>
      left.line - right.line || left.level - right.level);
    const activeIndex = Math.max(0, rows.findIndex((row) =>
      row.key === (selected ?? symbol)?.key));
    setPicker({
      kind: "symbols",
      anchor: breadcrumbPickerAnchor(event.currentTarget, sourceIndex),
      rows,
      activeIndex,
    });
  }, [outline, symbol?.key]);

  const openFile = useCallback((item: BreadcrumbFileItem) => {
    if (item.dir) {
      if (picker?.kind === "files") showFiles(picker.anchor, item.relPath, "");
      return;
    }
    setPicker(null);
    if (normalizedFilePath(item.relPath).toLocaleLowerCase()
      === normalizedFilePath(relPath).toLocaleLowerCase()) {
      onFocusEditor();
      return;
    }
    onOpenAt?.(item.relPath, 1);
  }, [onFocusEditor, onOpenAt, picker, relPath, showFiles]);

  const focusRow = useCallback((index: number) => {
    setPicker((current) => current
      ? { ...current, activeIndex: index } as BreadcrumbPickerState
      : current);
    window.requestAnimationFrame(() => rowRefs.current[index]?.focus());
  }, []);

  const handlePickerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!picker) return;
    const count = picker.rows.length;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePicker(true);
      return;
    }
    if (picker.kind === "files" && event.key === "ArrowLeft" && picker.directory) {
      event.preventDefault();
      const parent = picker.directory.split("/").slice(0, -1).join("/");
      showFiles(picker.anchor, parent, picker.directory);
      return;
    }
    if (!count) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp"
      || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0
        : event.key === "End" ? count - 1
          : (picker.activeIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      focusRow(next);
      return;
    }
    if (event.key === "Enter" || event.key === " "
      || (event.key === "ArrowRight" && picker.kind === "files"
        && picker.rows[picker.activeIndex]?.dir)) {
      event.preventDefault();
      rowRefs.current[picker.activeIndex]?.click();
    }
  }, [closePicker, focusRow, picker, showFiles]);

  useEffect(() => {
    if (!picker || picker.kind === "files" && picker.loading) return;
    window.requestAnimationFrame(() => rowRefs.current[picker.activeIndex]?.focus());
  }, [
    picker?.kind,
    picker?.kind === "files" ? picker.directory : "",
    picker?.kind === "files" ? picker.loading : false,
  ]);

  useEffect(() => {
    if (!picker) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (pickerRef.current?.contains(target)
        || buttonRefs.current.some((button) => button?.contains(target)))) return;
      setPicker(null);
    };
    window.addEventListener("pointerdown", dismiss, true);
    return () => window.removeEventListener("pointerdown", dismiss, true);
  }, [Boolean(picker)]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest(".editor-breadcrumb-actions")) return;
    const count = segments.length + symbols.length;
    if (!count) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
      onFocusEditor();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight"
      && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0
      : event.key === "End" ? count - 1
        : (focusIndex + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
    setFocusIndex(next);
    buttonRefs.current[next]?.focus();
  }, [focusIndex, onFocusEditor, segments.length, symbols.length]);

  const portal = picker
    ? createPortal(
        <div ref={pickerRef} className="editor-breadcrumb-picker" role="dialog"
          aria-label={picker.kind === "files" ? "File Breadcrumbs" : "Symbol Breadcrumbs"}
          style={{
            left: picker.anchor.x,
            top: picker.anchor.y,
            width: picker.anchor.width,
            maxHeight: picker.anchor.maxHeight,
          }}
          onKeyDown={handlePickerKeyDown}>
          {picker.kind === "files" && <div className="editor-breadcrumb-picker-header">
            <button type="button" aria-label="Parent Folder"
              disabled={!picker.directory}
              onClick={() => {
                const parent = picker.directory.split("/").slice(0, -1).join("/");
                showFiles(picker.anchor, parent, picker.directory);
              }}><ChevronLeft size={14} aria-hidden="true" /></button>
            <span title={picker.directory || projectPath}>
              {picker.directory || projectPath}
            </span>
          </div>}
          <div className="editor-breadcrumb-picker-tree" role="tree">
            {picker.kind === "files" && picker.loading
              && <p><ProgressSpinner size={14} className="editor-pane-spinner" /> Loading…</p>}
            {picker.kind === "files" && !picker.loading && picker.error && <p>{picker.error}</p>}
            {picker.kind === "files" && !picker.loading && !picker.error && !picker.rows.length
              && <p>No files found.</p>}
            {picker.kind === "symbols" && !picker.rows.length && <p>No symbols found.</p>}
            {picker.rows.map((item, index) => {
              const fileItem = picker.kind === "files" ? item as BreadcrumbFileItem : null;
              const symbolItem = picker.kind === "symbols" ? item as EditorOutlineItem : null;
              const selected = index === picker.activeIndex;
              return <button key={fileItem?.relPath || symbolItem?.key || index}
                ref={(node) => { rowRefs.current[index] = node; }}
                type="button"
                role="treeitem"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                style={symbolItem ? { paddingLeft: `${8 + symbolItem.level * 14}px` } : undefined}
                onFocus={() => setPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onMouseEnter={() => setPicker((current) => current
                  ? { ...current, activeIndex: index } as BreadcrumbPickerState
                  : current)}
                onClick={() => fileItem
                  ? openFile(fileItem)
                  : symbolItem && (() => {
                      setPicker(null);
                      onRevealSymbol(symbolItem);
                    })()}>
                {fileItem
                  ? fileItem.dir
                    ? <Folder size={14} aria-hidden="true" />
                    : <FileIcon size={14} aria-hidden="true" />
                  : <Braces size={14} aria-hidden="true" />}
                <span>{fileItem?.name || symbolItem?.name}</span>
                {symbolItem?.detail && <small>{symbolItem.detail}</small>}
              </button>;
            })}
          </div>
        </div>,
        document.body,
      )
    : null;

  return <>
    <nav className="editor-breadcrumbs" aria-label="Breadcrumbs" onKeyDown={handleKeyDown}>
      <span className="editor-breadcrumb-path">
        {segments.map((segment, index) =>
          <React.Fragment key={`${index}:${segment}`}>
            {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
            <button ref={(node) => { buttonRefs.current[index] = node; }}
              type="button"
              className={`editor-breadcrumb-item${index === segments.length - 1
                ? " editor-breadcrumb-current" : ""}`}
              title={segments.slice(0, index + 1).join("/")}
              aria-haspopup={accessToken ? undefined : "tree"}
              aria-expanded={picker?.kind === "files" && picker.anchor.sourceIndex === index}
              disabled={Boolean(accessToken)}
              tabIndex={focusIndex === index ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={(event) => openPath(event, index)}>
              {index === segments.length - 1
                ? <FileIcon size={14} aria-hidden="true" />
                : <Folder size={14} aria-hidden="true" />}
              <span>{segment}</span>
            </button>
          </React.Fragment>)}
        {symbols.map((item, symbolIndex) => {
          const index = segments.length + symbolIndex;
          return <React.Fragment key={item.key}>
            <ChevronRight size={14} aria-hidden="true" />
            <button ref={(node) => { buttonRefs.current[index] = node; }}
              type="button"
              className="editor-breadcrumb-item editor-breadcrumb-symbol"
              title={item.detail || item.name}
              aria-haspopup="tree"
              aria-expanded={picker?.kind === "symbols" && picker.anchor.sourceIndex === index}
              tabIndex={focusIndex === index ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={(event) => openSymbol(event, index, item)}>
              <Braces size={14} aria-hidden="true" />
              <span>{item.name}</span>
            </button>
          </React.Fragment>;
        })}
      </span>
      <span className="editor-breadcrumb-actions">
        {editable && <button type="button" className="editor-problems-action"
          onClick={onShowProblems} aria-label={t("Problems")} data-tooltip={t("Problems")}>
          <span className="editor-problems-count is-error" aria-hidden="true">
            <CircleX size={14} /><b>{problemStatus.errors}</b>
          </span>
          <span className="editor-problems-count is-warning" aria-hidden="true">
            <TriangleAlert size={14} /><b>{problemStatus.warnings}</b>
          </span>
        </button>}
        {editable && <button type="button" disabled={!dirty || saving || reverting} onClick={onSave}
            aria-label="Save" data-tooltip="Save (Ctrl+S)">
            <Save size={16} aria-hidden="true" />
          </button>}
        {editable && dirty && <button type="button" className="editor-revert-action" disabled={saving || reverting}
            onClick={onRevert} aria-label="Revert" data-tooltip="Revert File">
            <Undo2 size={18} aria-hidden="true" />
          </button>}
        <button type="button" aria-label="Reveal in Explorer" data-tooltip="Reveal in Explorer"
          onClick={() => void api?.revealFile?.(projectPath, relPath, accessToken)}>
          <FolderOpen size={16} aria-hidden="true" />
        </button>
      </span>
    </nav>
    {portal}
  </>;
}
