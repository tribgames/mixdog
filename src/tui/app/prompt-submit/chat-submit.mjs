/**
 * src/tui/app/prompt-submit/chat-submit.mjs - the normal prompt-box submit:
 * slash commands, and chat text with pasted image/text token expansion.
 */
import { buildPromptContentWithImages, imageReferenceIds, pastedTextReferenceIds } from '../../paste-attachments.mjs';

function referencedSnapshot(ref, ids) {
  return Object.fromEntries(Object.entries(ref.current || {}).filter(([id]) => ids.has(Number(id))));
}

// Pasted images travel as content; the restore metadata keeps everything but
// the bytes so a requeue can rebuild the token without re-reading the paste.
function imageRestoreMeta(imageSnapshot) {
  return Object.fromEntries(
    Object.entries(imageSnapshot).map(([id, image]) => {
      const { content: _content, ...metadata } = image;
      return [id, { ...metadata, sizeBytes: Math.floor((String(image.content || '').length * 3) / 4) }];
    })
  );
}

export function submitSlashCommand(ctx, commandText) {
  const { store, state, runSlashCommand, clearPastedImagesSnapshot } = ctx;
  if (state.commandBusy) {
    store.pushNotice('wait for the current command to finish', 'warn');
    return false;
  }
  const [cmd, ...rest] = commandText.slice(1).split(/\s+/);
  const accepted = runSlashCommand(cmd, rest.join(' ').trim());
  if (accepted !== false) clearPastedImagesSnapshot();
  return accepted;
}

export function submitChat(ctx, text) {
  const { state, submitPrompt, armTranscriptFollow, clearPastedImagesSnapshot, clearPastedTextsSnapshot } = ctx;
  const imageRefs = imageReferenceIds(text);
  const imageSnapshot = referencedSnapshot(ctx.pastedImagesRef, imageRefs);
  const hasImageSnapshot = Object.keys(imageSnapshot).length > 0;
  // Expand folded [Pasted text #N +M lines] tokens back to their original
  // text at the same point buildPromptContentWithImages runs. Broken /
  // partially-deleted tokens do not match and are left as-is.
  const textRefs = pastedTextReferenceIds(text);
  const textSnapshot = referencedSnapshot(ctx.pastedTextsRef, textRefs);
  const hasTextSnapshot = Object.keys(textSnapshot).length > 0;
  const content = buildPromptContentWithImages(text, imageSnapshot);
  const accepted = submitPrompt(content, {
    ...(hasImageSnapshot || hasTextSnapshot ? { displayText: text } : {}),
    pastedImages: imageRestoreMeta(imageSnapshot),
    pastedTexts: textSnapshot,
    onCommitted:
      hasImageSnapshot || hasTextSnapshot
        ? () => {
            clearPastedImagesSnapshot(imageSnapshot);
            clearPastedTextsSnapshot(textSnapshot);
          }
        : null,
  });
  if (accepted) {
    armTranscriptFollow();
    if (imageRefs.size === 0 || (!hasImageSnapshot && !state.busy)) clearPastedImagesSnapshot();
    else if (state.busy && hasImageSnapshot) clearPastedImagesSnapshot(imageSnapshot);
    if (textRefs.size === 0 || (!hasTextSnapshot && !state.busy)) clearPastedTextsSnapshot();
    else if (state.busy && hasTextSnapshot) clearPastedTextsSnapshot(textSnapshot);
  }
  return accepted;
}
