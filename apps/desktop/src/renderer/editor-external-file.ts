import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { openConfirmedFile } from './file-launch-confirmation';

export async function openEditorFileExternally(
  projectPath: string,
  relPath: string,
  accessToken?: string
): Promise<void> {
  try {
    const open = window.mixdogDesktop?.openFilePath;
    if (!open) throw new Error('Desktop file access is unavailable.');
    await openConfirmedFile((confirmedPath) =>
      confirmedPath ? open(projectPath, relPath, accessToken, confirmedPath) : open(projectPath, relPath, accessToken)
    );
  } catch (error) {
    showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
  }
}
