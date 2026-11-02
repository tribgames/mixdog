import { raiseDesktopNotice } from '../../../../../src/runtime/shared/desktop-notice-host.mjs';

/** This PC's OS encryption (Electron safeStorage) refused: saved logins and
 *  sign-ins can be neither opened nor sealed. Told once per run, under the
 *  same notice the runtime's keychain raises. */
export function noticeSecretStorageFailure(): void {
  raiseDesktopNotice('secret-storage', 'secret-storage-failed');
}

/** A safeStorage seal or unseal that tells the user once when it throws:
 *  encryption reported available, yet the secret cannot be sealed or opened. */
export function noticingSafeStorage<Input, Output>(run: (input: Input) => Output): (input: Input) => Output {
  return (input) => {
    try {
      return run(input);
    } catch (error) {
      noticeSecretStorageFailure();
      throw error;
    }
  };
}
