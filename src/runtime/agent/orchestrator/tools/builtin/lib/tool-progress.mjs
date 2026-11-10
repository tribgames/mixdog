// Completion progress (claude "Found N" parity). Best-effort, no-op when
// onProgress is absent (no progressToken).
export function reportToolProgress(options, text) {
  if (typeof options?.onProgress !== 'function') return;
  try {
    options.onProgress(text);
  } catch {
    /* best-effort */
  }
}
