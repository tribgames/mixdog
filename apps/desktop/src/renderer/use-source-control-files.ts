import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DesktopGitFile, DesktopGitStatus } from "../shared/contract";
import {
  changedFilesLabel,
  SCM_FILE_ROW_HEIGHT,
  SCM_SORT_KEY,
  statusKind,
  useRowWindow,
  type ScmSortKey,
} from "./source-control-support";

interface SourceControlFilesOptions {
  projectPath: string;
  status: DesktopGitStatus | null;
  active: boolean;
}

export function useSourceControlFiles({
  projectPath,
  status,
  active,
}: SourceControlFilesOptions) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [fileFilter, setFileFilter] = useState("");
  const [sortKey, setSortKey] = useState<ScmSortKey>(() => {
    try {
      const saved = window.localStorage.getItem(SCM_SORT_KEY);
      return saved === "name" || saved === "status" ? saved : "path";
    } catch { return "path"; }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const files = useMemo(() => status?.files ?? [], [status]);
  const conflicts = useMemo(() => files.filter((file) => file.conflicted), [files]);
  const isIncluded = useCallback(
    (file: DesktopGitFile) => !file.conflicted && !excluded.has(file.path),
    [excluded],
  );
  const includedFiles = useMemo(() => files.filter(isIncluded), [files, isIncluded]);

  useEffect(() => {
    setSelected(new Set());
    setExcluded(new Set());
    setFileFilter("");
  }, [projectPath]);
  useEffect(() => {
    setExcluded((current) => {
      if (!current.size) return current;
      const present = new Set(files.map((file) => file.path));
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [files]);

  const chooseSortKey = useCallback((next: ScmSortKey) => {
    setSortKey(next);
    try { window.localStorage.setItem(SCM_SORT_KEY, next); } catch { /* convenience */ }
  }, []);
  const sortedFiles = useMemo(() => [...files].sort((left, right) => {
    if (sortKey === "name") {
      const leftName = left.path.split("/").at(-1) || left.path;
      const rightName = right.path.split("/").at(-1) || right.path;
      return leftName.localeCompare(rightName) || left.path.localeCompare(right.path);
    }
    if (sortKey === "status") {
      return statusKind(left).localeCompare(statusKind(right))
        || left.path.localeCompare(right.path);
    }
    return left.path.localeCompare(right.path);
  }), [files, sortKey]);
  const filterText = fileFilter.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () => filterText
      ? sortedFiles.filter((file) => file.path.toLocaleLowerCase().includes(filterText))
      : sortedFiles,
    [filterText, sortedFiles],
  );
  const rowWindow = useRowWindow(
    scrollRef,
    SCM_FILE_ROW_HEIGHT,
    filteredFiles.length,
    active,
    `${projectPath}\u0000${sortKey}\u0000${filterText}`,
  );
  const visibleFiles = filteredFiles.slice(rowWindow.start, rowWindow.end);
  const includedVisible = filteredFiles.filter(isIncluded).length;
  const includableVisible = filteredFiles.filter((file) => !file.conflicted).length;

  const setIncluded = useCallback((file: DesktopGitFile, include: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }, []);
  const setAllIncluded = useCallback((
    include: boolean,
    rows: DesktopGitFile[] = filteredFiles,
  ) => {
    setExcluded((current) => {
      const next = new Set(current);
      for (const file of rows) {
        if (include) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  }, [filteredFiles]);
  const toggleSelected = useCallback((file: DesktopGitFile, additive = false) => {
    const key = file.path;
    setSelected((current) => {
      if (!additive) return new Set([key]);
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const selectedActionFiles = useCallback((file: DesktopGitFile): DesktopGitFile[] => {
    if (!selected.has(file.path)) return [file];
    const rows = filteredFiles.filter((candidate) => selected.has(candidate.path));
    return rows.length ? rows : [file];
  }, [filteredFiles, selected]);
  const clearSelected = useCallback(() => setSelected(new Set()), []);

  return {
    files,
    conflicts,
    includedFiles,
    filteredFiles,
    visibleFiles,
    fileWindow: rowWindow,
    filesScrollRef: scrollRef,
    fileFilter,
    setFileFilter,
    sortKey,
    chooseSortKey,
    selected,
    selectedCount: selected.size,
    clearSelected,
    isIncluded,
    setIncluded,
    setAllIncluded,
    toggleSelected,
    selectedActionFiles,
    includedVisible,
    includableVisible,
    checkAllLabel: changedFilesLabel(files.length, filteredFiles.length),
  };
}
