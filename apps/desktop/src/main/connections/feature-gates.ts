// What a server (ssh) window may not do. These features act on THIS PC — its
// screen and input, its Browser Use pane, its phone pairing, its app updater
// and notification sound, or its own files and OS shell — while the window's
// sessions live on the server. A server window's own file lanes (path
// resolution, reads, previews, uploads, downloads and the server trash) run
// on the server through its connection and are not gated; only what would
// implicitly hand a file to this PC's shell stays refused.
import { DESKTOP_IPC } from '../../shared/contract';
import type { ConnectionKind } from './contract';
import { ConnectionError } from './errors';

const FEATURE_CHANNELS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'Computer Use',
    [DESKTOP_IPC.computerReadiness, DESKTOP_IPC.openComputerPermissionSettings, DESKTOP_IPC.requestLinuxInputAccess],
  ],
  [
    'The browser pane',
    [
      DESKTOP_IPC.browserPageFrame,
      DESKTOP_IPC.browserPageControl,
      DESKTOP_IPC.browserPageMetadata,
      DESKTOP_IPC.browserPresentNative,
      DESKTOP_IPC.browserSetActiveGuest,
      DESKTOP_IPC.browserReleasePage,
      DESKTOP_IPC.browserConfigureGuestViewport,
      DESKTOP_IPC.browserApprovalDecide,
      DESKTOP_IPC.browserProfileImportSources,
      DESKTOP_IPC.browserProfileImportStart,
      DESKTOP_IPC.browserHistorySearch,
      DESKTOP_IPC.browserCredentialSuggestions,
      DESKTOP_IPC.browserCredentialFill,
      DESKTOP_IPC.browserSignedInSites,
      DESKTOP_IPC.browserSignOutSite,
      DESKTOP_IPC.browserClearSignIns,
      DESKTOP_IPC.browserVaultLogins,
      DESKTOP_IPC.browserVaultSave,
      DESKTOP_IPC.browserVaultDelete,
      DESKTOP_IPC.browserLoginOpen,
      DESKTOP_IPC.browserLoginStatus,
      DESKTOP_IPC.browserPageIdentity,
    ],
  ],
  [
    'Phone access',
    [
      DESKTOP_IPC.remoteAccessInfo,
      DESKTOP_IPC.rotateRemoteAccess,
      DESKTOP_IPC.revokeRemoteAccessClient,
      DESKTOP_IPC.remotePairCode,
      DESKTOP_IPC.getRemoteAccessSettings,
      DESKTOP_IPC.setRemoteAccessEnabled,
      DESKTOP_IPC.setRemotePcName,
      DESKTOP_IPC.setRemoteClientAlias,
      DESKTOP_IPC.listRemoteClientClaims,
      DESKTOP_IPC.resolveRemoteClientClaim,
    ],
  ],
  ['Desktop updates', [DESKTOP_IPC.getUpdaterState, DESKTOP_IPC.checkForDesktopUpdate, DESKTOP_IPC.showDesktopUpdate]],
  ['The notification sound preview', [DESKTOP_IPC.previewNotificationSound]],
  // Notification preferences are this PC's: a server's sessions notify here
  // and follow them, so they are set in this PC's window.
  [
    "This PC's notification settings",
    [
      DESKTOP_IPC.getNotificationPreferences,
      DESKTOP_IPC.setNotificationPreferences,
      DESKTOP_IPC.sendTestNotification,
      DESKTOP_IPC.listConversationNotifications,
      DESKTOP_IPC.setConversationNotification,
    ],
  ],
  // Opening this PC's files as the server's project files; attachments from
  // this PC upload into the server instead (serverUpload*).
  [
    "Opening this PC's files",
    [DESKTOP_IPC.chooseFile, DESKTOP_IPC.chooseFiles, DESKTOP_IPC.chooseWorkspace, DESKTOP_IPC.saveWorkspace],
  ],
  // Handing a server path to this PC's shell or file manager; the window
  // downloads to this PC explicitly (serverDownload*) or reveals in its tree.
  [
    "Opening server files with this PC's apps",
    [
      DESKTOP_IPC.openProjectInExplorer,
      DESKTOP_IPC.openMediaAsset,
      DESKTOP_IPC.openMediaFolder,
      DESKTOP_IPC.openLocalFileLink,
      DESKTOP_IPC.localPageUrl,
      DESKTOP_IPC.revealFile,
      DESKTOP_IPC.openFilePath,
    ],
  ],
];

/** What a refused channel offers instead, when the window has one. */
const ALTERNATIVES = new Map<string, string>([
  [DESKTOP_IPC.openFilePath, 'Use "Download to this PC and open" instead.'],
  [DESKTOP_IPC.openLocalFileLink, 'Open it in the editor, or download it to this PC.'],
  [DESKTOP_IPC.revealFile, "Reveal it in the window's file tree instead."],
  [DESKTOP_IPC.openProjectInExplorer, "Browse it in the window's file tree instead."],
  [DESKTOP_IPC.openMediaAsset, 'Use "Download to this PC and open" instead.'],
  [DESKTOP_IPC.openMediaFolder, "Reveal it in the window's file tree, or copy its server path."],
  [DESKTOP_IPC.chooseFile, 'Attach or drop the file to upload it to the server.'],
  [DESKTOP_IPC.chooseFiles, 'Attach or drop the files to upload them to the server.'],
]);

const SSH_UNSUPPORTED = new Map<string, string>(
  FEATURE_CHANNELS.flatMap(([feature, channels]) => channels.map((channel) => [channel, feature] as const))
);

/** IPC channels a server window refuses. */
export const SSH_UNSUPPORTED_CHANNELS: ReadonlySet<string> = new Set(SSH_UNSUPPORTED.keys());

/** The refusal for `channel` in a window of `kind`, or null when it may run. */
export function connectionFeatureGate(kind: ConnectionKind, channel: string): ConnectionError | null {
  if (kind !== 'ssh') return null;
  const feature = SSH_UNSUPPORTED.get(channel);
  if (!feature) return null;
  const alternative = ALTERNATIVES.get(channel);
  return new ConnectionError(
    'ssh-unsupported',
    `${feature} is not available in a server window.${alternative ? ` ${alternative}` : ''}`
  );
}

/** chooseProject in a server window: the local OS folder dialog cannot pick a
 *  server folder, so the renderer must use a server folder picker. */
export function remotePickerRequired(): ConnectionError {
  return new ConnectionError('remote-picker-required', 'Choose the project folder on the server.');
}
