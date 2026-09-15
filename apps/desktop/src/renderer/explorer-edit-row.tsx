// Inline create/rename row: the input that replaces a row label while a name is
// being typed. Enter commits a valid value, Escape cancels, blur commits what
// is valid, the live validation bubble blocks on an error and only informs on a
// warning, and F2 cycles the rename selection. The pane owns the edit state and
// the commit itself; this row owns the caret grammar.
import { useEffect, useRef, type ReactNode } from "react";
import type { ExplorerNameProblem } from "./explorer-logic";
import { t } from "./i18n";
import { SetiFileIcon } from "./SetiFileIcon";

export interface ExplorerEdit {
  mode: "new-file" | "new-folder" | "rename";
  parentRel: string;
  rel: string;
  initial: string;
  dir: boolean;
}

type ExplorerRenamePhase = "prefix" | "all" | "suffix";

/** Opening selection: renaming a file pre-selects the basename without its
 *  extension, so typing replaces the name and keeps the suffix. */
function openingSelectionEnd(edit: ExplorerEdit): number {
  const lastDot = edit.initial.lastIndexOf(".");
  return edit.mode === "rename" && !edit.dir && lastDot > 0 ? lastDot : edit.initial.length;
}

/** F2 inside a rename cycles basename → whole name → extension. */
export function nextExplorerRenameSelection(
  phase: ExplorerRenamePhase,
  value: string,
  dotIndex: number,
): { phase: ExplorerRenamePhase; start: number; end: number } {
  if (phase === "prefix") return { phase: "all", start: 0, end: value.length };
  if (phase === "all") return { phase: "suffix", start: dotIndex + 1, end: value.length };
  return { phase: "prefix", start: 0, end: dotIndex };
}

export function ExplorerEditRow({
  edit, value, problem, level, onChange, onCommit, onCancel,
}: {
  edit: ExplorerEdit;
  value: string;
  problem: ExplorerNameProblem | null;
  level: number;
  onChange(next: string): void;
  onCommit(): void;
  onCancel(): void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionPhase = useRef<ExplorerRenamePhase>("prefix");
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    selectionPhase.current = "prefix";
    input.focus();
    try { input.setSelectionRange(0, openingSelectionEnd(edit)); } catch { /* jsdom */ }
  }, [edit]);
  const editDir = edit.mode === "new-folder" || (edit.mode === "rename" && edit.dir);
  return <div className="dock-file-row explorer-edit-row"
    style={{ paddingLeft: `calc(var(--mx-explorer-inset, 12px) + ${level * 8}px)` }}>
    <span className="explorer-twistie" aria-hidden="true" />
    {/* renderInputBox updates the icon live while the user types. */}
    {!editDir && <SetiFileIcon name={value || "file"} className="dock-file-icon" />}
    <span className="explorer-edit-box" data-problem={problem?.severity || undefined}>
      <input ref={inputRef} value={value} spellCheck={false}
        aria-label={t("Type file name. Press Enter to confirm or Escape to cancel.")}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "F2" && edit.mode === "rename" && !edit.dir) {
            const input = event.currentTarget;
            const dotIndex = input.value.lastIndexOf(".");
            if (dotIndex === -1) return;
            event.preventDefault();
            const next = nextExplorerRenameSelection(selectionPhase.current, input.value, dotIndex);
            selectionPhase.current = next.phase;
            input.setSelectionRange(next.start, next.end);
          } else if (event.key === "Enter") {
            if (problem?.severity === "error") return;
            onCommit();
          } else if (event.key === "Escape") {
            onCancel();
          }
        }}
        onBlur={() => {
          if (problem?.severity === "error") onCancel();
          else onCommit();
        }} />
      {problem && <span className={`explorer-edit-message ${problem.severity}`} role="alert">
        {problem.content}
      </span>}
    </span>
  </div>;
}
