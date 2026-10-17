import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { openConfirmedFile } from './file-launch-confirmation';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { isSshConnectionWindow } from './desktop-connection';
import { downloadAndOpenServerFile } from './server-transfers';
import { startProjectFileDownload } from './project-file-download';

export async function openEditorFileExternally(
  projectPath: string,
  relPath: string,
  accessToken?: string,
  /** The conversation owning the surface; a paired device downloads as it. */
  sessionId = ''
): Promise<void> {
  // The host's OS cannot open anything for a paired device: it downloads instead.
  if (isRemoteHostRenderer()) {
    await startProjectFileDownload(sessionId, relPath, undefined, accessToken ? projectPath : undefined);
    return;
  }
  // A server file reaches this PC's app only as an explicit download.
  if (isSshConnectionWindow()) {
    await downloadAndOpenServerFile(projectPath, relPath, accessToken);
    return;
  }
  try {
    const open = window.mixdogDesktop?.openFilePath;
    if (!open) throw new Error(t('Desktop file access is unavailable.'));
    await openConfirmedFile((confirmedPath) =>
      confirmedPath ? open(projectPath, relPath, accessToken, confirmedPath) : open(projectPath, relPath, accessToken)
    );
  } catch (error) {
    showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
  }
}
