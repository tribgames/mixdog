// prompt-handlers/use-prompt-paste.mjs
// handlePromptPaste: bracketed paste and the Ctrl+V shortcut, bound to the
// live cwd/provider and the App-owned attachment registries.
import { useCallback } from 'react';
import {
  readClipboardImageAttachment,
  readClipboardText,
  readImageAttachmentFromPath,
} from '../../paste-attachments.mjs';
import { pasteFromClipboard, processPastedText } from './paste-pipeline.mjs';

export function usePromptPaste({ state, showPromptHint, registerPastedImage, registerPastedText }) {
  return useCallback(
    (text, meta = {}) => {
      const source = String(meta?.source || 'paste');
      const value = String(text ?? '');
      const attachImagePath = async (pathText) => {
        try {
          const image = await readImageAttachmentFromPath(pathText, state.cwd || process.cwd(), {
            provider: state.provider || '',
          });
          if (!image) return pathText;
          const ref = registerPastedImage(image);
          showPromptHint(`attached ${image.filename || 'image'}`, 'plain');
          return ref;
        } catch (e) {
          showPromptHint(`image attach failed: ${e?.message || e}`, 'warn');
          return pathText;
        }
      };
      const processText = (raw, returnRaw = false) =>
        processPastedText(raw, { returnRaw, registerPastedText, attachImagePath });
      // The async clipboard result is applied by handleExternalPaste under its
      // pasteGeneration staleness guard, so a stale resolve is dropped.
      if (source === 'clipboard-shortcut' && !value) {
        return pasteFromClipboard({
          readText: readClipboardText,
          readImage: () => readClipboardImageAttachment({ provider: state.provider || '' }),
          processText,
          registerPastedImage,
          showPromptHint,
        });
      }
      return processText(value);
    },
    [registerPastedImage, registerPastedText, showPromptHint, state.cwd, state.provider]
  );
}
