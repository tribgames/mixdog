/**
 * src/tui/session/notice-surface.mjs - toasts, transcript notices, progress hint.
 */
import { roomRowSender } from '../../runtime/agent/orchestrator/session/agent-room.mjs';
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
        ...getState().toasts,
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
    // A routine result is a finished sentence, never a raw error to polish;
    // a group-room row is someone's words, kept verbatim (a pass has none).
    const value =
      options.routine || options.room || options.heldRequest ? String(text ?? '').trim() : polishNoticeText(text);
    if (!value && !options.room) return null;
    const forceTranscript = options.transcript === true;
    if (!forceTranscript) return pushToast(value, tone, options.ttlMs, options);
    const userRow = options.room?.kind === 'user';
    // A room user row keeps its message id (the sender's submission id), as a
    // turn's own prompt row keeps its submission id.
    const id = (userRow && options.messageId) || nextId();
    // One row per messageId: a routine's live-only run row (running, delivery
    // failed) gives way to the row that follows it (routine-result.mjs).
    if (options.messageId) {
      const current = getState().items;
      const items = current.filter((it) => !(it?.kind === 'notice' && it?.messageId === options.messageId));
      if (items.length !== current.length) set({ items: replaceItems(items, { preserveStreamingTail: true }) });
    }
    pushItem({
      // A group-room row (agent-room.mjs): the user's own words are their
      // bubble; every member row is a notice the app renders from `room`.
      kind: userRow ? 'user' : 'notice',
      id,
      text: value,
      ...(userRow ? {} : { tone }),
      // A schedule result posted into a home thread (routine-result.mjs).
      ...(options.routine ? { routine: options.routine } : {}),
      ...(options.room ? { room: options.room } : {}),
      // A room message another session sent shows its sender, as restored.
      ...(userRow ? roomRowSender(options.room) : {}),
      // A room user row's files, in the fields a prompt row draws them from;
      // a task report's or member speech's returned files likewise.
      ...(Array.isArray(options.attachments) && options.attachments.length ? { attachments: options.attachments } : {}),
      ...(userRow && Array.isArray(options.images) && options.images.length ? { images: options.images } : {}),
      // A held request of an unattended run (human-gate/held-message.mjs).
      ...(options.heldRequest ? { heldRequest: options.heldRequest } : {}),
      ...(options.messageId ? { messageId: options.messageId } : {}),
    });
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
