import { Search, X } from "lucide-react";

export type SourceControlView = "changes" | "history";

export function SourceControlViewControls({
  fileCount,
  fileFilter,
  historyQuery,
  view,
  onFileFilterChange,
  onHistoryQueryChange,
  onViewChange,
}: {
  fileCount: number;
  fileFilter: string;
  historyQuery: string;
  view: SourceControlView;
  onFileFilterChange(value: string): void;
  onHistoryQueryChange(value: string): void;
  onViewChange(view: SourceControlView): void;
}) {
  const options = [
    { id: "changes" as const, label: "Changes" },
    { id: "history" as const, label: "History" },
  ];

  return <div className="dock-scm-view-controls">
    <label className="dock-scm-search workbench-search-input">
      <Search size={14} aria-hidden="true" />
      {view === "changes" ? <>
        <input type="search" value={fileFilter}
          aria-label="Filter changed files" placeholder="Filter"
          onInput={(event) => onFileFilterChange(event.currentTarget.value)} />
        {fileFilter && <button type="button" aria-label="Clear the file filter"
          onClick={() => onFileFilterChange("")}><X size={14} aria-hidden="true" /></button>}
      </> : <>
        <input type="search" value={historyQuery} placeholder="Search commits"
          aria-label="Search commits"
          onInput={(event) => onHistoryQueryChange(event.currentTarget.value)} />
        {historyQuery && <button type="button" aria-label="Clear the commit search"
          onClick={() => onHistoryQueryChange("")}><X size={14} aria-hidden="true" /></button>}
      </>}
    </label>
    <div className="dock-scm-tab-bar" role="radiogroup" aria-label="Changes or history">
      {options.map((option, index) => <button type="button" role="radio" key={option.id}
        className="dock-scm-tab"
        data-review-option={option.id}
        aria-checked={view === option.id}
        tabIndex={view === option.id ? 0 : -1}
        onClick={() => onViewChange(option.id)}
        onKeyDown={(event) => {
          const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
          const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
          if (!forward && !backward) return;
          event.preventDefault();
          const step = forward ? 1 : options.length - 1;
          const next = options[(index + step) % options.length];
          onViewChange(next.id);
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>(`[data-review-option="${next.id}"]`)
            ?.focus();
        }}>
        <span className="dock-scm-tab-content">
          <span className="dock-scm-tab-label">{option.label}</span>
          {option.id === "changes" && fileCount > 0 &&
            <span className="dock-review-count">{fileCount}</span>}
        </span>
      </button>)}
    </div>
  </div>;
}
