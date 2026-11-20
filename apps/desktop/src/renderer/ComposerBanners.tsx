import { createPortal } from 'react-dom';
import { t } from './i18n';
import { MxIcon } from './MxIcon';

/** The file-drop overlay. Notices and errors go to the toast lane, not above the input card. */
export function ComposerBanners({
  draggingFiles,
  transitioning,
  dropTarget,
}: {
  draggingFiles: boolean;
  transitioning: boolean;
  dropTarget: HTMLElement | null;
}) {
  return draggingFiles && !transitioning && dropTarget
    ? createPortal(
        <div className="task-drop-overlay" role="status">
          <MxIcon name="photo" size={16} />
          <span>{t('Drop files or paths')}</span>
        </div>,
        dropTarget
      )
    : null;
}
