/**
 * Condition-based waiting. Sequence dispatch lives separately so waiting
 * never needs to know how the next gesture will address the page.
 */
import { boundedInteger } from '../command';
import { measureBrowserPhase } from '../timing';
import { sequenceActions } from './sequence';
import { defineBrowserActions } from './types';

export const flowActions = defineBrowserActions({
  ...sequenceActions,
  async wait({ guest, command, signal, targetIsBackground, services }) {
    const { documents, reply } = services;
    const wantText = typeof command.text === 'string' && command.text.trim() ? command.text.trim() : '';
    const wantTextGone = typeof command.textGone === 'string' && command.textGone.trim()
      ? command.textGone.trim()
      : '';
    const wantUrl = typeof command.url === 'string' && command.url.trim() ? command.url.trim() : '';
    if (!wantText && !wantTextGone && !wantUrl) {
      throw new Error('wait requires text, textGone, and/or url (substrings to wait for)');
    }
    const timeoutMs = boundedInteger(command.timeoutMs, 10_000, 500, 30_000);
    const startedAt = Date.now();
    const matched = await measureBrowserPhase('wait', async () => {
    const changes = await documents.observeChanges(guest, signal);
    try {
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
      const revision = changes.latch.version;
      const urlOk = !wantUrl || guest.getURL().toLowerCase().includes(wantUrl.toLowerCase());
      let textOk = !wantText;
      let textGoneOk = !wantTextGone;
      if (urlOk && (wantText || wantTextGone)) {
        const pageText = await documents.pageText(guest, signal).then((text) => text.toLowerCase()).catch((error) => {
          if (signal?.aborted) throw signal.reason || error;
          return null;
        });
        textOk = pageText !== null && (!wantText || pageText.includes(wantText.toLowerCase()));
        textGoneOk = pageText !== null && (!wantTextGone || !pageText.includes(wantTextGone.toLowerCase()));
      }
      if (urlOk && textOk && textGoneOk) {
        return true;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await changes.latch.wait(revision, Math.min(300, timeoutMs - (Date.now() - startedAt)), signal);
    }
    } finally {
      await changes.close();
    }
    });
    if (!matched) {
      const waited = [
        wantText && `text ${JSON.stringify(wantText)}`,
        wantTextGone && `textGone ${JSON.stringify(wantTextGone)}`,
        wantUrl && `url ${JSON.stringify(wantUrl)}`,
      ].filter(Boolean).join(' and ');
      const outcome = command.internalStep ? { text: '' }
        : await reply.snapshotResult(guest, command, signal, { targetIsBackground }).catch((error) => {
          if (signal?.aborted) throw signal.reason || error;
          return { text: '' };
        });
      throw new Error(`Wait timed out after ${timeoutMs}ms without matching ${waited}.\n\n${outcome.text}`);
    }
    const elapsed = Date.now() - startedAt;
    const outcome = command.internalStep ? { text: '' }
      : await reply.snapshotResult(guest, command, signal, { targetIsBackground });
    return {
      ...outcome,
      text: `Condition met after ${elapsed}ms.\n\n${outcome.text}`,
    };
  },
});
