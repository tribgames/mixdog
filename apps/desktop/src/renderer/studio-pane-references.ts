import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { readStudioDraftReferences, type StudioReferenceStore, writeStudioDraftReferences } from './studio-draft-cache';
import type { StudioReference } from './studio-media-state';

// Reference images persist as a draft: restored once on mount (never over refs
// the user already added) and written back while the pane is active.
export function useStudioDraftReferences(
  active: boolean,
  referenceStore: StudioReferenceStore | undefined,
  refs: StudioReference[],
  setRefs: Dispatch<SetStateAction<StudioReference[]>>
) {
  const [refsHydrated, setRefsHydrated] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: setRefs is a stable state setter; hydration reruns only for a new store
  useEffect(() => {
    let stopped = false;
    void readStudioDraftReferences(referenceStore).then((cached) => {
      if (stopped) return;
      setRefs((current) =>
        current.length
          ? current
          : cached.map((reference) => ({
              ...reference,
              url: `data:${reference.mime};base64,${reference.base64}`,
            }))
      );
      setRefsHydrated(true);
    });
    return () => {
      stopped = true;
    };
  }, [referenceStore]);
  useEffect(() => {
    if (!active || !refsHydrated) return;
    void writeStudioDraftReferences(refs, referenceStore);
  }, [active, referenceStore, refs, refsHydrated]);
}
