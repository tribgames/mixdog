// Pasted-attachment buffers. Large pasted images and
// texts fold into [Image #N] / [Pasted text #N +M lines] prompt tokens; the
// original payloads live here (ref + mirrored state) until submit expands
// them back. install* rehydrates a queued/restored draft's buffers, the
// snapshot clears drop exactly the entries a submit consumed, and register*
// mints the next token for a fresh paste.
import { useCallback, useRef, useState } from 'react';
import { formatImageRef, formatPastedTextRef } from '../paste-attachments.mjs';

// One buffer kind (images or texts): the mirrored ref + state, the id
// sequence, and the install / snapshot-clear / register trio. `toEntry` builds
// the stored payload for a fresh paste — a falsy entry registers nothing and
// leaves the id sequence untouched — and `formatRef` mints its prompt token.
function usePastedBufferSlice({ toEntry, formatRef }) {
  const [, setBuffers] = useState({});
  const buffersRef = useRef({});
  const nextIdRef = useRef(1);

  const install = useCallback((buffers, { merge = true } = {}) => {
    if (!buffers || typeof buffers !== 'object' || Object.keys(buffers).length === 0) return;
    const next = merge ? { ...buffersRef.current, ...buffers } : { ...buffers };
    buffersRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextIdRef.current) nextIdRef.current = maxId + 1;
    setBuffers(next);
  }, []);

  const clearSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(buffersRef.current || {}).length === 0) return;
      buffersRef.current = {};
      setBuffers({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...buffersRef.current };
    let changed = false;
    for (const [id, buffer] of Object.entries(snapshot)) {
      if (next[id] === buffer) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    buffersRef.current = next;
    setBuffers(next);
  }, []);

  const register = useCallback((input) => {
    const id = nextIdRef.current;
    const entry = toEntry(input, id);
    if (!entry) return '';
    nextIdRef.current = id + 1;
    buffersRef.current = { ...buffersRef.current, [id]: entry };
    setBuffers(buffersRef.current);
    return formatRef(entry);
  }, []);

  return { buffersRef, nextIdRef, install, clearSnapshot, register };
}

export function usePastedBuffers() {
  const images = usePastedBufferSlice({
    toEntry: (image, id) => (image?.type === 'image' && image.content ? { ...image, id } : null),
    formatRef: (entry) => formatImageRef(entry.id),
  });
  const texts = usePastedBufferSlice({
    toEntry: (text, id) => {
      const value = String(text ?? '');
      return value ? { id, text: value } : null;
    },
    formatRef: (entry) => formatPastedTextRef(entry.id, entry.text),
  });

  return {
    pastedImagesRef: images.buffersRef,
    nextPastedImageIdRef: images.nextIdRef,
    pastedTextsRef: texts.buffersRef,
    nextPastedTextIdRef: texts.nextIdRef,
    installPastedImages: images.install,
    clearPastedImagesSnapshot: images.clearSnapshot,
    registerPastedImage: images.register,
    installPastedTexts: texts.install,
    clearPastedTextsSnapshot: texts.clearSnapshot,
    registerPastedText: texts.register,
  };
}
