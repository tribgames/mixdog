/**
 * src/tui/session/notice-surface.mjs - toasts, transcript notices, progress hint.
 */
import { polishNoticeText } from './notice-text.mjs';
import { nextId } from './transcript-spill.mjs';

export function createNoticeSurface({ getState, set, isDisposed, pushItem, replaceItems }) {
  const toastTimers = new Set();
  const pushToast = (text, tone = 'info', ttlMs = 3000, options = {}) => {
    const id = nextId();
    const value = String(text ?? '').trim();
    if (!value) return null;
    set({
      toasts: [
        ...getState().toasts.filter((toast) => toast.id !== id),
        {
          id,
          text: value,
          tone,
          ...(options.owner ? { owner: options.owner } : {}),
        },
      ],
    });
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      if (isDisposed()) return;
      set({ toasts: getState().toasts.filter((toast) => toast.id !== id) });
    }, ttlMs);
    toastTimers.add(timer);
    timer.unref?.();
    return id;
  };
  const pushNotice = (text, tone = 'info', options = {}) => {
    const value = polishNoticeText(text);
    if (!value) return null;
    const forceTranscript = options.transcript === true;
    if (!forceTranscript) return pushToast(value, tone, options.ttlMs, options);
    const id = nextId();
    pushItem({ kind: 'notice', id, text: value, tone });
    return id;
  };
  // Remove a transcript notice previously created via pushNotice(...,
  // {transcript:true}). Used for transient-but-persistent notices (e.g. the
  // manual OAuth URL) that must disappear once their flow concludes.
  const removeNotice = (id) => {
    if (id == null) return false;
    const current = getState().items;
    const items = current.filter((it) => !(it?.kind === 'notice' && it?.id === id));
    if (items.length === current.length) return false;
    set({ items: replaceItems(items, { preserveStreamingTail: true }) });
    return true;
  };
  // Sticky (non-TTL) input-hint-line progress state, for long-running
  // installs (e.g. voice runtime download) that would otherwise spam the
  // 3s toast queue. Distinct from pushToast/pushNotice: it persists across
  // renders until explicitly cleared (setProgressHint('', ...) or a falsy
  // text), and App.jsx's inputHint falls back to it only when no promptHint
  // and no live toast currently cover the same line.
  const setProgressHint = (text, tone = 'info', percent) => {
    const value = String(text ?? '').trim();
    const numericPercent = Number(percent);
    let progressHint = null;
    if (value) {
      progressHint = { text: value, tone };
      if (Number.isFinite(numericPercent))
        progressHint.percent = Math.max(0, Math.min(100, Math.round(numericPercent)));
    }
    set({ progressHint });
  };
  const clearToastTimers = () => {
    for (const timer of toastTimers) {
      clearTimeout(timer);
    }
    toastTimers.clear();
  };
  return { pushToast, pushNotice, removeNotice, setProgressHint, clearToastTimers };
}
