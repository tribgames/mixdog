// Attachment preflight: before a send, the attachments user messages carry
// inline are priced against the model window. Attachments that would crowd it
// travel by reference instead (attachments/attachment-reference.mjs): the model
// gets each file's path, page count and text-layer status and reads only the
// pages it needs. The rewrite lands in the live transcript, so a failed or
// retried turn keeps the reference form too and can never re-send the bulk.
import { isReferencableMediaPart, referenceMessageMedia } from '../../../attachments/attachment-reference.mjs';
import { imagePartAllowance, pdfPartAllowance } from './context-utils.mjs';

// Inline attachments may take at most this share of the model window, summed
// over the transcript. The rest stays for the conversation, tool results and
// the answer; above it the read-what-you-need path costs far less than the
// whole files.
export const ATTACHMENT_INLINE_SHARE = 0.25;

/** The inline-attachment budget of a model window (0 when unknown). */
export function attachmentInlineBudget(contextWindow) {
  const window = Number(contextWindow);
  return window > 0 ? Math.floor(window * ATTACHMENT_INLINE_SHARE) : 0;
}

function partInlineTokens(part, nativePdf) {
  return part.type === 'image' ? imagePartAllowance(part) : pdfPartAllowance(part, { nativePdf });
}

/** The tokens the attachments of one message's own content cost inline. */
export function messageAttachmentTokens(message, { nativePdf = true } = {}) {
  if (message?.role !== 'user' || !Array.isArray(message.content)) return 0;
  return message.content.reduce(
    (sum, part) => sum + (isReferencableMediaPart(part) ? partInlineTokens(part, nativePdf) : 0),
    0
  );
}

// A PDF with no text layer lowers to empty text for a provider that reads PDFs
// as text: inline it says nothing, by reference the read tool can OCR it.
function carriesTextlessScan(message, nativePdf) {
  if (nativePdf || message?.role !== 'user' || !Array.isArray(message.content)) return false;
  return message.content.some(
    (part) =>
      isReferencableMediaPart(part) && part.type !== 'image' && Number(part.pageCount) > 0 && part.textPages === 0
  );
}

/**
 * Rewrites, in place, the user messages whose attachments must travel by
 * reference: every message with a text-less scan on a text-only provider, any
 * message whose attachments alone exceed the inline budget, then the oldest
 * attachment messages until the transcript's inline attachments fit it.
 * Returns what was done; `changed` is false when nothing was rewritten.
 */
export function referenceOversizedAttachments(messages, { contextWindow, nativePdf = true } = {}) {
  const budget = attachmentInlineBudget(contextWindow);
  const result = { changed: false, referencedMessages: 0, inlineTokensBefore: 0, budgetTokens: budget };
  if (!budget || !Array.isArray(messages)) return result;
  const carriers = [];
  for (let index = 0; index < messages.length; index += 1) {
    const tokens = messageAttachmentTokens(messages[index], { nativePdf });
    if (tokens > 0) carriers.push({ index, tokens });
  }
  result.inlineTokensBefore = carriers.reduce((sum, carrier) => sum + carrier.tokens, 0);
  let inline = result.inlineTokensBefore;
  const reference = (carrier) => {
    const next = referenceMessageMedia(messages[carrier.index]);
    if (next === messages[carrier.index]) return;
    messages[carrier.index] = next;
    inline -= carrier.tokens - messageAttachmentTokens(next, { nativePdf });
    carrier.tokens = 0;
    result.changed = true;
    result.referencedMessages += 1;
  };
  for (const carrier of carriers) {
    if (carrier.tokens > budget || carriesTextlessScan(messages[carrier.index], nativePdf)) reference(carrier);
  }
  for (const carrier of carriers) {
    if (inline <= budget) break;
    if (carrier.tokens > 0) reference(carrier);
  }
  return result;
}
