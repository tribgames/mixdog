// "Remote Access" window: one glanceable card for the installable web app.
// Relay-only (works from any network — user decision: no LAN fallback).
// Until the relay link is up the window shows a connecting note instead of
// falling back to a device-specific client.
import type { BrowserWindow } from 'electron';
import QRCode from 'qrcode';

import type { DesktopRemoteAccessInfo } from '../shared/contract';
import type { RelayE2EEPairingMaterial } from '../shared/remote-e2ee';

export interface RemoteAccessDescriptor {
  relay: {
    clientUrl: string;
    token: string;
    pairing: RelayE2EEPairingMaterial;
  };
}

const qrSvg = (value: string): Promise<string> =>
  QRCode.toString(value, { type: 'svg', margin: 1, width: 220, color: { dark: '#141414', light: '#f2f2f2' } });

export async function buildRemoteAccessInfo(
  descriptor: RemoteAccessDescriptor,
): Promise<DesktopRemoteAccessInfo> {
  const { relay } = descriptor;
  // The relay-visible token only routes the socket. E2EE material stays in
  // the browser fragment so it never reaches HTTP logs.
  const relayOrigin = new URL(relay.clientUrl).origin;
  const key = encodeURIComponent(relay.pairing.serverPublicKey);
  const secret = encodeURIComponent(relay.pairing.pairingSecret);
  const relayBrowserUrl = `${relayOrigin}/?token=${encodeURIComponent(relay.token)}`
    + `#e2eeKey=${key}&e2eeSecret=${secret}`;
  return {
    relayBrowserUrl,
    relayBrowserQrSvg: await qrSvg(relayBrowserUrl),
  };
}

export async function showRemoteAccessWindow(
  info: DesktopRemoteAccessInfo,
  parent?: BrowserWindow | null,
): Promise<void> {
  const { BrowserWindow: ElectronBrowserWindow } = await import('electron');
  const browserQr = info.relayBrowserQrSvg;
  const paired = Boolean(browserQr);
  const body = paired
    ? `<div class="grid single">
  <div class="card"><b>Open or install the web app</b>${browserQr}<small>Chrome/Edge: Install app · Safari: Add to Home Screen</small></div>
</div>`
    : `<div class="grid single">
  <div class="card"><b>Connecting…</b><small>Establishing the secure relay link. Close this window and press Ctrl+Shift+R again in a moment. If this persists, check this PC's internet connection.</small></div>
</div>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Remote access</title>
<style>
  body { margin: 0; padding: 28px; background: #151518; color: #e9e9e9;
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
<h1>Web app</h1>
<p>Works on any network. Scan the secure link, then install it from the browser menu if desired.</p>
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
    backgroundColor: '#151518',
    parent: parent ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setMenuBarVisibility(false);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
