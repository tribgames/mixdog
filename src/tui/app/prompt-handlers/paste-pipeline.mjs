// prompt-handlers/paste-pipeline.mjs
// What a paste turns into before it reaches the prompt: raw text, a folded
// paste token, or a mix of image refs and folded text runs. Pure over the
// callbacks that register tokens/attachments and read the clipboard.
import { splitPastedImagePathCandidates } from '../../paste-attachments.mjs';
import { shouldFoldPastedText } from '../../paste-text-policy.mjs';

/** Mixed paste: fold each CONTIGUOUS run of non-image text into its own token
 *  (only if over threshold) so content order around image refs is preserved.
 *  '\n' separator chunks are plain text and stay inside their surrounding run. */
function joinPastedParts(chunks, parts, registerPastedText) {
  let out = '';
  let run = '';
  const flushRun = () => {
    if (!run) return;
    out += shouldFoldPastedText(run) ? registerPastedText(run) : run;
    run = '';
  };
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].imagePath) {
      flushRun();
      out += parts[i];
    } else {
      run += parts[i];
    }
  }
  flushRun();
  return out;
}

/** Fold-or-insert pipeline shared by bracketed paste and the Ctrl+V text path.
 *  No image paths: fold the whole text into a token when large, otherwise
 *  insert it raw — `undefined` lets PromptInput insert `raw` itself, while
 *  returnRaw=true returns the string (the clipboard-text path's outer `text`
 *  is empty, so the handleExternalPaste fallback would insert nothing). With
 *  image paths, each one resolves through `attachImagePath` (ref or the
 *  original text) and the result is a Promise of the joined prompt text. */
export function processPastedText(raw, { returnRaw = false, registerPastedText, attachImagePath }) {
  const chunks = splitPastedImagePathCandidates(raw);
  if (!chunks.some((chunk) => chunk.imagePath)) {
    if (shouldFoldPastedText(raw)) return registerPastedText(raw);
    return returnRaw ? raw : undefined;
  }
  return Promise.all(chunks.map((chunk) => (chunk.imagePath ? attachImagePath(chunk.text) : chunk.text))).then(
    (parts) => joinPastedParts(chunks, parts, registerPastedText)
  );
}

/** Ctrl+V / Meta+V: clipboard.read() model. Prefer OS-clipboard TEXT (routed
 *  through the SAME fold pipeline as bracketed paste); when the clipboard holds
 *  no text, fall back to the image-attachment path. Resolves false when
 *  nothing usable was found or the read failed. */
export function pasteFromClipboard({ readText, readImage, processText, registerPastedImage, showPromptHint }) {
  return readText()
    .then((clip) => {
      const normalized = String(clip ?? '').replace(/\r\n?/g, '\n');
      if (normalized) return processText(normalized, true);
      return readImage().then((image) => {
        if (!image) {
          showPromptHint('no text or image found on clipboard', 'plain');
          return false;
        }
        const ref = registerPastedImage(image);
        showPromptHint(`attached ${image.filename || 'clipboard image'}`, 'plain');
        return ref;
      });
    })
    .catch((e) => {
      showPromptHint(`paste failed: ${e?.message || e}`, 'warn');
      return false;
    });
}
