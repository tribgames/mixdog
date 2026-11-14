// What a server (ssh) window may not do, keyed by DesktopApi member. These features act on THIS PC (its screen and input, its
// Browser Use pane, its phone pairing, its app updater and notification sound, its own files and OS shell) while the window's
// sessions live on the server. A server window's own file lanes (path resolution, reads, previews, uploads, downloads and the
// server trash) run on the server through its connection and are not gated; only what would implicitly hand a file to this
// PC's shell stays refused.
import type { DesktopApi } from './contract';

const THIS_PC_FEATURES = [
  {
    feature: 'Computer Use',
    keys: ['computerReadiness', 'openComputerPermissionSettings', 'requestLinuxInputAccess', 'approvePcAccess'],
  },
  {
    feature: 'The browser pane',
    keys: [
      'browserPageFrame', 'browserPageControl', 'browserPageMetadata', 'browserPresentNative', 'browserSetActiveGuest',
      'browserPanelShown', 'browserReleasePage', 'browserConfigureGuestViewport', 'browserApprovalDecide',
      'browserProfileImportSources', 'browserProfileImportStart', 'browserHistorySearch', 'browserCredentialSuggestions',
      'browserCredentialFill', 'browserSignedInSites', 'browserSignOutSite', 'browserClearSignIns', 'browserVaultLogins',
      'browserVaultSave', 'browserVaultDelete', 'browserLinkedSignIns', 'browserLinkedSignInDelete', 'browserLoginOpen',
      'browserLoginStatus', 'browserPageIdentity',
    ],
  },
  {
    feature: 'Phone access',
    keys: [
      'getRemoteAccessInfo', 'rotateRemoteAccess', 'revokeRemoteAccessClient', 'getRemotePairCode',
      'getRemoteAccessSettings', 'setRemoteAccessEnabled', 'setRemotePcName', 'setRemoteClientAlias',
      'listRemoteClientClaims', 'resolveRemoteClientClaim',
    ],
  },
  { feature: 'Desktop updates', keys: ['getUpdaterState', 'checkForDesktopUpdate', 'showDesktopUpdate'] },
  { feature: 'The notification sound preview', keys: ['previewNotificationSound'] },
  // Notification preferences are this PC's: a server's sessions notify here and follow them, so they are set in this PC's window.
  {
    feature: "This PC's notification settings",
    keys: [
      'getNotificationPreferences', 'setNotificationPreferences', 'sendTestNotification', 'listConversationNotifications',
      'setConversationNotification',
    ],
  },
  // Opening this PC's files as the server's project files; attachments from this PC upload into the server instead (serverUpload*).
  { feature: "Opening this PC's files", keys: ['chooseFile', 'chooseFiles', 'chooseWorkspace', 'saveWorkspace'] },
  // Handing a server path to this PC's shell or file manager; the window downloads to this PC explicitly (serverDownload*) or
  // reveals in its tree.
  {
    feature: "Opening server files with this PC's apps",
    keys: [
      'openProjectInExplorer', 'openMediaAsset', 'openMediaFolder', 'openLocalFileLink', 'localPageUrl', 'revealFile',
      'openFilePath',
    ],
  },
] as const satisfies ReadonlyArray<{ feature: string; keys: readonly (keyof DesktopApi)[] }>;

/** What a refused member offers instead, when the window has one. */
const ALTERNATIVES: Readonly<Partial<Record<keyof DesktopApi, string>>> = {
  openFilePath: 'Use "Download to this PC and open" instead.',
  openLocalFileLink: 'Open it in the editor, or download it to this PC.',
  revealFile: "Reveal it in the window's file tree instead.",
  openProjectInExplorer: "Browse it in the window's file tree instead.",
  openMediaAsset: 'Use "Download to this PC and open" instead.',
  openMediaFolder: "Reveal it in the window's file tree, or copy its server path.",
  chooseFile: 'Attach or drop the file to upload it to the server.',
  chooseFiles: 'Attach or drop the files to upload them to the server.',
};

type FeatureKey = (typeof THIS_PC_FEATURES)[number]['keys'][number];

/** The DesktopApi members a server window refuses. */
export const THIS_PC_FEATURE_KEYS: readonly FeatureKey[] = THIS_PC_FEATURES.flatMap((group) => group.keys);

const FEATURE_OF = new Map<string, string>(
  THIS_PC_FEATURES.flatMap((group) => group.keys.map((key) => [key, group.feature] as const))
);

/** The refusal for `key` in a server window (the text the connection gate gave, code first), or null when it may run. */
export function thisPcFeatureRefusal(key: string): string | null {
  const feature = FEATURE_OF.get(key);
  if (!feature) return null;
  const alternative = ALTERNATIVES[key as keyof DesktopApi];
  return `ssh-unsupported: ${feature} is not available in a server window.${alternative ? ` ${alternative}` : ''}`;
}
