import { t } from './i18n';
import type { DockAction } from './pane-dock-chrome';
import { zoomBarAction } from './zoom-bar-pref';

/** The breadcrumb overflow menu: Format Document for an editable text file
 *  with a formatter, and the shared zoom-bar toggle on zoomable previews
 *  (image, SVG, PDF/Office pages). */
export function editorBreadcrumbMenuActions({
  formattingAvailable,
  load,
  preview,
  documentPreview,
  zoomable,
  formatDocument,
}: {
  formattingAvailable: boolean;
  load: { binary?: boolean; tooLarge?: boolean; readOnly?: boolean } | null | undefined;
  preview: unknown;
  documentPreview: unknown;
  zoomable: boolean;
  formatDocument(): void;
}): DockAction[] {
  const actions: DockAction[] =
    formattingAvailable && load && !load.binary && !load.tooLarge && !preview && !documentPreview && !load.readOnly
      ? [{ id: 'format', label: t('Format Document'), onSelect: formatDocument }]
      : [];
  if (zoomable) actions.push(zoomBarAction(true));
  return actions;
}
