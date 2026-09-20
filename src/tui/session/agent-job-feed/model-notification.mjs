import { readImageAttachmentFromPath } from '../../paste-attachments.mjs';

// Channel inbound images arrive as a JSON-array-of-paths meta value (stringified
// across the notify IPC boundary). Parse defensively; a malformed value simply
// yields no images and the notification degrades to its text body.
function parseInboundImagePaths(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

// Read each downloaded image into a real image content block so the channel
// turn is vision-visible. Any unreadable path is skipped.
async function loadImageParts(imagePaths, modelContent, getProvider) {
  const parts = [];
  if (modelContent) parts.push({ type: 'text', text: modelContent });
  for (const p of imagePaths) {
    let att = null;
    try {
      att = await readImageAttachmentFromPath(p, process.cwd(), { provider: getProvider() });
    } catch {
      att = null;
    }
    if (!att) continue;
    if (att.metadataText) parts.push({ type: 'text', text: att.metadataText });
    parts.push({ type: 'image', data: att.content, mimeType: att.mediaType || 'image/png' });
  }
  return parts;
}

// The plain `enqueue` delivery: task/schedule notifications are lower-priority
// queue items that drain between turns, behind direct user input.
export function createModelNotificationEnqueue({ chain, enqueue, getState, getDisposed }) {
  function enqueueNotification({ event, text, delivery, notificationKey }) {
    const modelContent = String(delivery.modelContent ?? delivery.displayText ?? text).trim();
    const imagePaths = parseInboundImagePaths(event?.meta?.image_paths);
    if (!modelContent && imagePaths.length === 0) return true;
    const enqueueOpts = {
      mode: 'task-notification',
      priority: 'later',
      key: notificationKey || undefined,
      displayText: delivery.displayText || text,
    };
    // Image load failed or overran its budget: still deliver the text body so
    // the notification is never silently lost.
    const enqueueTextFallback = () => {
      if (!getDisposed() && modelContent) enqueue(modelContent, enqueueOpts);
    };
    if (imagePaths.length > 0) {
      // Async, but the notification is already "handled" (return true) — the
      // enqueue lands on resolve, in arrival order via the shared chain.
      chain.push(async (slot) => {
        if (getDisposed()) return;
        const parts = await loadImageParts(imagePaths, modelContent, () => getState()?.provider || '');
        if (getDisposed() || slot.abandoned) return;
        const hasImage = parts.some((part) => part.type === 'image');
        if (!hasImage && !modelContent) return;
        enqueue(hasImage ? parts : modelContent, enqueueOpts);
      }, enqueueTextFallback);
      return true;
    }
    if (chain.isBusy()) {
      // An earlier image notification is still loading: queue behind it so
      // this text body cannot overtake it in the model queue.
      chain.push((slot) => {
        if (!getDisposed() && !slot.abandoned) enqueue(modelContent, enqueueOpts);
      }, enqueueTextFallback);
      return true;
    }
    enqueue(modelContent, enqueueOpts);
    return true;
  }

  return { enqueueNotification };
}
