import { useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PersistentPanePortal } from './PaneSurfaceGate';
import { DownloadSessionContext } from './project-file-download';

/**
 * Side-dock file editors live here, one per file, and are moved into the slot
 * their pane draws for them (PersistentPanePortal): a tab's file tabs going
 * behind another tab's, a New Task draft becoming its session, or the tab
 * moving to another pane re-homes the slot, never the editor, so an edit in
 * progress (text, undo, cursor) stays as it is.
 */
type Registration = {
  slotId: string;
  node: ReactNode;
  /** The editor as drawn while no slot shows it. */
  hiddenNode: ReactNode;
  downloadSession: string;
  onFocusPane?: () => void;
  slot: object;
  /** No slot holds it: kept, unseen, while `kept` says so (SideFileEditorPortals). */
  orphan?: boolean;
};

const registrations = new Map<string, Registration>();
let snapshot: readonly (readonly [string, Registration])[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = [...registrations];
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readSnapshot = () => snapshot;

/** The pane's place for one file's editor (`editorKey`: the file's key). */
export function SideFileEditorSlot({
  editorKey,
  slotId,
  shown,
  onFocusPane,
  hidden,
  children,
}: {
  editorKey: string;
  slotId: string;
  shown: boolean;
  /** Focuses this slot's pane on a click inside the editor (absent while focused). */
  onFocusPane?: () => void;
  /** The editor drawn inactive, for while no slot holds it. */
  hidden: ReactNode;
  children: ReactNode;
}) {
  const downloadSession = useContext(DownloadSessionContext);
  const [slot] = useState(() => ({}));
  useLayoutEffect(() => {
    registrations.set(editorKey, { slotId, node: children, hiddenNode: hidden, downloadSession, onFocusPane, slot });
    publish();
  });
  useLayoutEffect(
    () => () => {
      // The file's slot in its new place registers in this same commit, or
      // in a commit right after it; an editor no slot took back is orphaned,
      // and the host releases it unless it must be kept.
      window.setTimeout(() => {
        const registration = registrations.get(editorKey);
        if (registration?.slot !== slot) return;
        registrations.set(editorKey, { ...registration, orphan: true });
        publish();
      }, 0);
    },
    [editorKey, slot]
  );
  return <div id={slotId} className="pane-side-file-tab" hidden={!shown} />;
}

/** Every side-dock file editor, each in the slot its pane draws for it. An
 *  editor no slot holds (its pane's dock body is not drawn) stays while
 *  `kept(editorKey)` (unsaved edits on a file a dock still holds), so it is
 *  the same editor when a slot takes it again. */
export function SideFileEditorPortals({ kept }: { kept(editorKey: string): boolean }) {
  const entries = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
  useEffect(() => {
    let released = false;
    for (const [editorKey, registration] of registrations) {
      if (!registration.orphan || kept(editorKey)) continue;
      registrations.delete(editorKey);
      released = true;
    }
    if (released) publish();
  });
  return entries.map(([editorKey, registration]) => (
    <PersistentPanePortal
      key={editorKey}
      targetId={registration.slotId}
      className="side-file-persistent-surface"
      onPointerDownCapture={
        registration.onFocusPane
          ? (event) => {
              if (event.button === 0) registration.onFocusPane?.();
            }
          : undefined
      }
    >
      <DownloadSessionContext.Provider value={registration.downloadSession}>
        {registration.orphan ? registration.hiddenNode : registration.node}
      </DownloadSessionContext.Provider>
    </PersistentPanePortal>
  ));
}
