import { useMemo } from 'react';
import { t } from './i18n';
import { parseUnifiedDiff } from './renderer-logic.mjs';
import { GitDiffBody } from './ReviewPane';

/** The hover preview's diff body. Loaded on first hover so the diff renderer
 *  stays out of the transcript's first-screen bundle. */
export default function TurnChangesPreviewDiff({ patch }: { patch: string }) {
  const parts = useMemo(() => {
    try {
      return parseUnifiedDiff(patch);
    } catch {
      return [];
    }
  }, [patch]);
  if (parts.length === 0) return <p className="turn-changes-preview-note">{t('Preview unavailable')}</p>;
  return (
    <>
      {parts.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parsed parts are positional and never reorder
        <GitDiffBody key={index} file={part} mode="unified" />
      ))}
    </>
  );
}
