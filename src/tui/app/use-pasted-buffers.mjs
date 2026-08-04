// Pasted-attachment buffers, extracted from App.jsx. Large pasted images and
// texts fold into [Image #N] / [Pasted text #N +M lines] prompt tokens; the
// original payloads live here (ref + mirrored state) until submit expands
// them back. install* rehydrates a queued/restored draft's buffers, the
// snapshot clears drop exactly the entries a submit consumed, and register*
// mints the next token for a fresh paste.
import { useCallback, useRef, useState } from 'react';
import { formatImageRef, formatPastedTextRef } from '../paste-attachments.mjs';

export function usePastedBuffers() {
  const [, setPastedImages] = useState({});
  const pastedImagesRef = useRef({});
  const nextPastedImageIdRef = useRef(1);
  const [, setPastedTexts] = useState({});
  const pastedTextsRef = useRef({});
  const nextPastedTextIdRef = useRef(1);

  const installPastedImages = useCallback((images, { merge = true } = {}) => {
    if (!images || typeof images !== 'object' || Object.keys(images).length === 0) return;
    const next = merge ? { ...pastedImagesRef.current, ...images } : { ...images };
    pastedImagesRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextPastedImageIdRef.current) nextPastedImageIdRef.current = maxId + 1;
    setPastedImages(next);
  }, []);

  const clearPastedImagesSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(pastedImagesRef.current || {}).length === 0) return;
      pastedImagesRef.current = {};
      setPastedImages({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...pastedImagesRef.current };
    let changed = false;
    for (const [id, image] of Object.entries(snapshot)) {
      if (next[id] === image) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    pastedImagesRef.current = next;
    setPastedImages(next);
  }, []);

  const registerPastedImage = useCallback((image) => {
    if (!image || image.type !== 'image' || !image.content) return '';
    const id = nextPastedImageIdRef.current++;
    const entry = { ...image, id };
    pastedImagesRef.current = { ...pastedImagesRef.current, [id]: entry };
    setPastedImages(pastedImagesRef.current);
    return formatImageRef(id);
  }, []);

  const installPastedTexts = useCallback((texts, { merge = true } = {}) => {
    if (!texts || typeof texts !== 'object' || Object.keys(texts).length === 0) return;
    const next = merge ? { ...pastedTextsRef.current, ...texts } : { ...texts };
    pastedTextsRef.current = next;
    const maxId = Object.keys(next)
      .map((id) => Number(id) || 0)
      .reduce((max, id) => Math.max(max, id), 0);
    if (maxId >= nextPastedTextIdRef.current) nextPastedTextIdRef.current = maxId + 1;
    setPastedTexts(next);
  }, []);

  const clearPastedTextsSnapshot = useCallback((snapshot = null) => {
    if (!snapshot) {
      if (Object.keys(pastedTextsRef.current || {}).length === 0) return;
      pastedTextsRef.current = {};
      setPastedTexts({});
      return;
    }
    if (typeof snapshot !== 'object' || Object.keys(snapshot).length === 0) return;
    const next = { ...pastedTextsRef.current };
    let changed = false;
    for (const [id, text] of Object.entries(snapshot)) {
      if (next[id] === text) {
        delete next[id];
        changed = true;
      }
    }
    if (!changed) return;
    pastedTextsRef.current = next;
    setPastedTexts(next);
  }, []);

  const registerPastedText = useCallback((text) => {
    const value = String(text ?? '');
    if (!value) return '';
    const id = nextPastedTextIdRef.current++;
    const entry = { id, text: value };
    pastedTextsRef.current = { ...pastedTextsRef.current, [id]: entry };
    setPastedTexts(pastedTextsRef.current);
    return formatPastedTextRef(id, value);
  }, []);

  return {
    pastedImagesRef,
    nextPastedImageIdRef,
    pastedTextsRef,
    nextPastedTextIdRef,
    setPastedImages,
    setPastedTexts,
    installPastedImages,
    clearPastedImagesSnapshot,
    registerPastedImage,
    installPastedTexts,
    clearPastedTextsSnapshot,
    registerPastedText,
  };
}
