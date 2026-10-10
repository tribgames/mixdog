import { clipboard, type ContextMenuParams, Menu, type MenuItemConstructorOptions, shell, type WebContents } from 'electron';
import { requiredExternalUrl } from './ipc-validation';
import { nativeT } from './native-i18n';

/** The groups a right-click offers where no surface menu took the event:
 *  spelling fixes, link and image actions, then text editing. */
function defaultContextMenuItems(contents: WebContents, params: ContextMenuParams): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  if (params.dictionarySuggestions.length) {
    groups.push(
      params.dictionarySuggestions.map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) }))
    );
  }
  if (params.linkURL) {
    const link = params.linkURL;
    let external: string | null = null;
    try {
      external = requiredExternalUrl(link);
    } catch {
      external = null;
    }
    groups.push([
      ...(external ? [{ label: nativeT('Open in browser'), click: () => void shell.openExternal(external) }] : []),
      { label: nativeT('Copy link'), click: () => clipboard.writeText(link) },
    ]);
  }
  if (params.mediaType === 'image') {
    groups.push([{ label: nativeT('Copy image'), click: () => contents.copyImageAt(params.x, params.y) }]);
  }
  const flags = params.editFlags;
  if (params.isEditable) {
    groups.push(
      [
        { role: 'undo', label: nativeT('Undo'), enabled: flags.canUndo },
        { role: 'redo', label: nativeT('Redo'), enabled: flags.canRedo },
      ],
      [
        { role: 'cut', label: nativeT('Cut'), enabled: flags.canCut },
        { role: 'copy', label: nativeT('Copy'), enabled: flags.canCopy },
        { role: 'paste', label: nativeT('Paste'), enabled: flags.canPaste },
        { role: 'selectAll', label: nativeT('Select All'), enabled: flags.canSelectAll },
      ]
    );
  } else if (params.selectionText.trim()) {
    groups.push([{ role: 'copy', label: nativeT('Copy') }]);
  }
  return groups.flatMap((group, index) => (index ? [{ type: 'separator' as const }, ...group] : group));
}

/** Electron shows nothing on right-click by default. Surfaces with their own
 *  menu cancel the DOM event, so this fills in only where nothing else does. */
export function installDefaultContextMenu(contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const items = defaultContextMenuItems(contents, params);
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}
