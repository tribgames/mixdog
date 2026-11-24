// The text every client-library failure carries for display, and nothing else turns one into text: the renderer (desktop window
// and phone) builds each failure with it from boot.js's catalog (renderer/main.tsx), main gives it to a failure as it leaves for a
// window (ipc.ts). Here, not in shared/, because the native catalogs are collected from main's sources; i18n:sync adds these keys
// to boot.js's catalog too (scripts/i18n/catalog-state.mjs).
import type { ClientErrorDetail } from '../../../../../packages/protocol-client/src/index.ts';

/** The sentence for `detail` (`t` translates a catalog key); `undefined` for a core refusal, whose message is the core's own. The
 *  detail keeps what the sentence leaves out (the method, the op, the digest) for logs. */
export function clientFailureText(detail: ClientErrorDetail, t: (key: string) => string): string | undefined {
  switch (detail.kind) {
    case 'rpc':
      return undefined;
    case 'requestTimeout':
      return t('Mixdog did not answer in time. Try again.');
    case 'connectionLost':
      return t('The connection to Mixdog was lost before it answered. Try again.');
    case 'clientClosed':
      return t('The connection to Mixdog was closed.');
    case 'versionRefused':
      return t('This app and Mixdog on the computer are different versions. Update both to the same version.');
    case 'unknownMethod':
      return t('This version of Mixdog does not support this action.');
    case 'opNotApplied':
      return t('The connection was interrupted before this action ran, so nothing changed. Try it again.');
    case 'opOutcomeUnknown':
      return t(
        'The connection was interrupted before this action was confirmed, so it may have run. Check before trying it again.'
      );
    case 'blobNotFound':
      return t('This content is no longer available.');
    case 'blobCorrupt':
      return t('This content is damaged and could not be read.');
    case 'protocolViolation':
      return t('Mixdog sent an answer this app could not read. Try again.');
    default: {
      const unhandled: never = detail;
      return unhandled;
    }
  }
}
