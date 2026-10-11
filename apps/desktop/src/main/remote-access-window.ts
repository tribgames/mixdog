// "Remote Access" window: one glanceable card with the phone-app QR.
// Relay-only (works from any network — user decision: no LAN fallback).
// Until the relay link is up the window shows a connecting note instead of
// falling back to a device-specific client.
import type { BrowserWindow } from 'electron';
import QRCode from 'qrcode';

import type { DesktopRemoteAccessInfo, DesktopRemoteClientInfo } from '../shared/contract';

export interface RemoteAccessDescriptor {
  relay: {
    clientUrl: string;
    token: string;
    clients?: DesktopRemoteClientInfo[];
  };
  /** False while access is switched off; the relay fields are then empty. */
  enabled?: boolean;
}

const qrSvg = (value: string): Promise<string> =>
  QRCode.toString(value, { type: 'svg', margin: 1, width: 220, color: { dark: '#141414', light: '#f2f2f2' } });

export async function buildRemoteAccessInfo(descriptor: RemoteAccessDescriptor): Promise<DesktopRemoteAccessInfo> {
  const { relay } = descriptor;
  // The QR carries a ROUTE to this desktop, no credential: it opens the
  // install guide, and access is granted by approving the request the
  // installed app then makes. Nothing secret ever reaches an HTTP log or a
  // photographed code.
  const relayBrowserUrl = relay.clientUrl;
  if (descriptor.enabled === false) {
    return {
      relayBrowserUrl: '',
      relayBrowserQrSvg: '',
      relayAppQrSvg: '',
      relayConnectUrl: '',
      clients: relay.clients ?? [],
      enabled: false,
    };
  }
  const { origin } = new URL(relayBrowserUrl);
  return {
    enabled: true,
    relayBrowserUrl,
    relayBrowserQrSvg: await qrSvg(relayBrowserUrl),
    relayAppQrSvg: await qrSvg(`${origin}/app`),
    relayConnectUrl: `${origin}/connect`,
    clients: relay.clients ?? [],
  };
}

/** The pairing card for a daemon descriptor, or null when there is none. The
 *  relay leg is up by the time a descriptor exists, so a failure here is the QR
 *  renderer itself: it is logged, or the Settings card would blame the network. */
export async function remoteAccessInfoFromDescriptor(descriptor: unknown): Promise<DesktopRemoteAccessInfo | null> {
  if (!descriptor || typeof descriptor !== 'object') return null;
  try {
    return await buildRemoteAccessInfo(descriptor as RemoteAccessDescriptor);
  } catch (error) {
    console.error('[mixdog-remote-access] pairing QR build failed:', error);
    return null;
  }
}

export async function showRemoteAccessWindow(
  info: DesktopRemoteAccessInfo,
  parent?: BrowserWindow | null
): Promise<void> {
  const { BrowserWindow: ElectronBrowserWindow } = await import('electron');
  const browserQr = info.relayAppQrSvg;
  const paired = Boolean(browserQr);
  const body = paired
    ? `<div class="grid single">
  <div class="card"><b>Scan with your phone camera to install the Mixdog app</b>${browserQr}<small>Then open the app, tap Connect with a code, and enter the 6-digit code shown in Settings → Connection.<br/>Every new device asks this PC for approval.</small></div>
</div>`
    : `<div class="grid single">
  <div class="card"><b>Connecting…</b><small>Establishing the secure relay link. Close this window and press Ctrl+Shift+R again in a moment. If this persists, check this PC's internet connection.</small></div>
</div>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Remote access</title>
<style>
  body { margin: 0; padding: 28px; background: #111114; color: #e9e9e9;
    font: 400 14px/21px system-ui, sans-serif; user-select: text; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  p { margin: 0 0 18px; color: #a8a8a8; font-size: 12.5px; line-height: 18px; }
  .grid { display: flex; gap: 20px; }
  .grid.single { justify-content: center; }
  .grid.single .card { max-width: 244px; }
  .card { flex: 1; display: grid; gap: 10px; justify-items: center;
    padding: 16px 12px; border-radius: 12px; background: #222225; }
  .card b { font-size: 13px; }
  .card svg { width: 200px; height: 200px; border-radius: 8px; }
  .card small { color: #a8a8a8; font-size: 11px; text-align: center; }
</style>
<h1>Connect a device</h1>
<p>Works on any network. Approve the connection request that appears here.</p>
${body}`;
  const window = new ElectronBrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Remote access',
    backgroundColor: '#111114',
    parent: parent ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setMenuBarVisibility(false);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
