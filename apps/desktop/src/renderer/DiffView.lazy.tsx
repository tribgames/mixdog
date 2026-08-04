import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { type ComponentProps, useEffect, useMemo, useState } from "react";

type DiffData = ComponentProps<typeof DiffView>["data"];

// Surfaces that print the `@@ … @@` header themselves — the Git diff pane's
// sticky hunk row that carries Stage Hunk — used to get a SECOND copy of it
// from the library, which renders every hunk header as an in-table row. Parse
// the patch exactly as the library would and drop only the hunk ROWS: line
// numbers, add/remove classification and hunk boundaries all come from that
// same parse, so the rendered diff is otherwise byte-identical.
function hunkHeaderFreeFile(data: DiffData): DiffFile | null {
  try {
    const source = DiffFile.createInstance({
      oldFile: data?.oldFile,
      newFile: data?.newFile,
      hunks: data?.hunks ?? [],
    });
    source.initRaw();
    source.buildSplitDiffLines();
    source.buildUnifiedDiffLines();
    const bundle = source._getFullBundle();
    return DiffFile.createInstance({}, { ...bundle, splitHunkLines: {}, unifiedHunkLines: {} });
  } catch {
    return null;
  }
}

export default function LazyDiffView({ data, mode, hideHunkHeader }: {
  data: DiffData;
  mode?: "unified" | "split";
  hideHunkHeader?: boolean;
}) {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => window.getComputedStyle(document.documentElement).colorScheme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(window.getComputedStyle(root).colorScheme === "light" ? "light" : "dark");
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["style", "data-mixdog-theme"] });
    return () => observer.disconnect();
  }, []);
  const headerFree = useMemo(
    () => hideHunkHeader ? hunkHeaderFreeFile(data) : null,
    [data, hideHunkHeader],
  );
  const diffViewMode = mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified;
  return headerFree
    ? <DiffView
      diffFile={headerFree}
      diffViewMode={diffViewMode}
      diffViewTheme={theme}
      diffViewWrap
      diffViewFontSize={12}
    />
    : <DiffView
      data={data}
      diffViewMode={diffViewMode}
      diffViewTheme={theme}
      diffViewWrap
      diffViewFontSize={12}
    />;
}
