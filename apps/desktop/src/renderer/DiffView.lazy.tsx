import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { type ComponentProps, useEffect, useMemo, useState } from 'react';
import { createVersionedDiffHighlighter, sharedDiffHighlighter } from './shared-diff-lowlight';
import { ensureSharedLowlightLanguages } from './shared-lowlight-extra';

type DiffData = ComponentProps<typeof DiffView>['data'];

// The library renders every hunk header as an in-table row; surfaces that print `@@ … @@` themselves drop only those rows from the library's own parse.
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

export default function LazyDiffView({
  data,
  mode,
  hideHunkHeader,
  highlight = false,
}: {
  data: DiffData;
  mode?: 'unified' | 'split';
  hideHunkHeader?: boolean;
  /** Syntax colours by the file name's language (opt-in per surface). */
  highlight?: boolean;
}) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.getComputedStyle(document.documentElement).colorScheme === 'light' ? 'light' : 'dark'
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(window.getComputedStyle(root).colorScheme === 'light' ? 'light' : 'dark');
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-mixdog-theme'] });
    return () => observer.disconnect();
  }, []);
  const [highlightVersion, setHighlightVersion] = useState(0);
  useEffect(() => {
    if (!highlight) return;
    let cancelled = false;
    void ensureSharedLowlightLanguages([
      { lang: data?.oldFile?.fileLang, fileName: data?.oldFile?.fileName },
      { lang: data?.newFile?.fileLang, fileName: data?.newFile?.fileName },
    ]).then((loaded) => {
      if (!cancelled && loaded) setHighlightVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [highlight, data?.oldFile?.fileLang, data?.oldFile?.fileName, data?.newFile?.fileLang, data?.newFile?.fileName]);
  const activeHighlighter = useMemo(
    () => (highlightVersion === 0 ? sharedDiffHighlighter : createVersionedDiffHighlighter(highlightVersion)),
    [highlightVersion]
  );
  const headerFree = useMemo(() => (hideHunkHeader ? hunkHeaderFreeFile(data) : null), [data, hideHunkHeader]);
  const diffViewMode = mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified;
  return headerFree ? (
    <DiffView
      diffFile={headerFree}
      diffViewMode={diffViewMode}
      diffViewTheme={theme}
      diffViewWrap
      diffViewHighlight={highlight}
      diffViewFontSize={12}
      registerHighlighter={activeHighlighter}
    />
  ) : (
    <DiffView
      data={data}
      diffViewMode={diffViewMode}
      diffViewTheme={theme}
      diffViewWrap
      diffViewHighlight={highlight}
      diffViewFontSize={12}
      registerHighlighter={activeHighlighter}
    />
  );
}
