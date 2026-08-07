// "Remote Access" window: one glanceable card with the phone pairing QRs.
// Relay-only (works from any network — user decision: no LAN fallback).
// Browser tab QR opens the web app; Android tab QRs install the APK and
// deep-link the installed app (mixdog://pair). Until the relay link is up
// the window shows a connecting note instead of LAN QRs.
import type { BrowserWindow } from 'electron';
import QRCode from 'qrcode';

import type { DesktopRemoteAccessInfo } from '../shared/contract';
import type { RelayE2EEPairingMaterial } from '../shared/remote-e2ee';

export interface RemoteAccessDescriptor {
  bridge: {
    port: number;
    token: string;
    urls: string[];
  } | null;
  relay: {
    clientUrl: string;
    token: string;
    pairing: RelayE2EEPairingMaterial;
  } | null;
}

function preferredUrl(urls: string[]): string {
  // Home-router LAN addresses first: Tailscale/VPN interfaces only work when
  // the phone runs the same overlay network.
  return urls.find((url) => url.includes('//192.168.'))
    || urls.find((url) => url.includes('//10.'))
    || urls[0]
    || '';
}

const qrSvg = (value: string): Promise<string> =>
  QRCode.toString(value, { type: 'svg', margin: 1, width: 220, color: { dark: '#141414', light: '#f2f2f2' } });

export async function buildRemoteAccessInfo(
  descriptor: RemoteAccessDescriptor,
): Promise<DesktopRemoteAccessInfo> {
  const { bridge, relay } = descriptor;
  // The LAN leg is optional: when another mixdog instance owns the bridge
  // port (live + dev app side by side) relay-only pairing still works, so
  // the LAN fields simply stay empty instead of failing the whole card.
  const origin = bridge ? preferredUrl(bridge.urls) : '';
  const browserUrl = bridge ? `${origin}/?token=${encodeURIComponent(bridge.token)}` : '';
  const appLink = bridge
    ? `mixdog://pair?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(bridge.token)}`
    : '';
  // The LAN leg gates static assets on the pairing token, so the install link
  // carries it too (a camera scan has no cookie yet).
  const apkUrl = bridge ? `${origin}/mixdog.apk?token=${encodeURIComponent(bridge.token)}` : '';
  const info: DesktopRemoteAccessInfo = {
    port: bridge?.port ?? 0,
    urls: bridge?.urls ?? [],
    browserUrl,
    appLink,
    apkUrl,
    browserQrSvg: '',
    appQrSvg: '',
  };
  if (bridge) {
    [info.browserQrSvg, info.appQrSvg] = await Promise.all([qrSvg(browserUrl), qrSvg(appLink)]);
  }
  if (relay) {
    // The relay-visible token only routes the socket. E2EE material stays in
    // the browser fragment or in the native deep link scanned by the phone.
    const relayOrigin = new URL(relay.clientUrl).origin;
    const key = encodeURIComponent(relay.pairing.serverPublicKey);
    const secret = encodeURIComponent(relay.pairing.pairingSecret);
    info.relayBrowserUrl = `${relayOrigin}/?token=${encodeURIComponent(relay.token)}`
      + `#e2eeKey=${key}&e2eeSecret=${secret}`;
    info.relayAppLink = `mixdog://pair?server=${encodeURIComponent(relayOrigin)}`
      + `&token=${encodeURIComponent(relay.token)}&e2eeKey=${key}&e2eeSecret=${secret}`;
    // Install downloads are the relay's biggest per-user bandwidth cost, so
    // the QR points at the GitHub release asset (public CDN, no token). The
    // relay still serves /mixdog.apk behind the pairing token as a fallback.
    info.relayApkUrl = 'https://github.com/tribgames/mixdog/releases/latest/download/mixdog.apk';
    [info.relayBrowserQrSvg, info.relayAppQrSvg] = await Promise.all([
      qrSvg(info.relayBrowserUrl),
      qrSvg(info.relayAppLink),
    ]);
  }
  // Install QR: scanning it downloads the APK directly (no typed URL).
  const installUrl = info.relayApkUrl || apkUrl;
  if (installUrl) info.apkQrSvg = await qrSvg(installUrl);
  return info;
}

export async function showRemoteAccessWindow(
  info: DesktopRemoteAccessInfo,
  parent?: BrowserWindow | null,
): Promise<void> {
  const { BrowserWindow: ElectronBrowserWindow } = await import('electron');
  const browserQr = info.relayBrowserQrSvg;
  const appQr = info.relayAppQrSvg;
  const paired = Boolean(browserQr && appQr);
  const body = paired
    ? `<nav class="tabs">
  <button class="active" data-tab="browser">Browser</button>
  <button data-tab="android">Android</button>
</nav>
<section data-pane="browser">
  <div class="grid single">
    <div class="card"><b>Open in the browser</b>${browserQr}<small>Works on iPhone and Android — no install needed</small></div>
  </div>
</section>
<section data-pane="android" hidden>
  <div class="grid">
    <div class="card"><b>1 · Install</b>${info.apkQrSvg}<small>Downloads the Android app (APK)</small></div>
    <div class="card"><b>2 · Pair</b>${appQr}<small>Connects the installed app to this PC</small></div>
  </div>
</section>`
    : `<div class="grid single">
  <div class="card"><b>Connecting…</b><small>Establishing the secure relay link. Close this window and press Ctrl+Shift+R again in a moment. If this persists, check this PC's internet connection.</small></div>
</div>`;
  const html = `<!doctype html><meta charset="utf-8"><title>Remote access</title>
<style>
  body { margin: 0; padding: 28px; background: #151518; color: #e9e9e9;
    font: 400 14px/21px system-ui, sans-serif; user-select: text; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  p { margin: 0 0 18px; color: #a8a8a8; font-size: 12.5px; line-height: 18px; }
  .tabs { display: flex; justify-content: center; gap: 6px; margin: 0 0 18px; }
  .tabs button { padding: 7px 16px; border: 0; border-radius: 999px; background: transparent;
    color: #a8a8a8; font: 500 13px/18px system-ui, sans-serif; cursor: pointer; }
  .tabs button.active { background: #323236; color: #e9e9e9; }
  .tabs button:hover { color: #e9e9e9; }
  .grid { display: flex; gap: 20px; }
  .grid.single { justify-content: center; }
  .grid.single .card { max-width: 244px; }
  .card { flex: 1; display: grid; gap: 10px; justify-items: center;
    padding: 16px 12px; border-radius: 12px; background: #222225; }
  .card b { font-size: 13px; }
  .card svg { width: 200px; height: 200px; border-radius: 8px; }
  .card small { color: #a8a8a8; font-size: 11px; text-align: center; }
</style>
<h1>Phone remote</h1>
<p>Works on any network. Scan with the phone camera.</p>
${body}
<script>
  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((entry) => {
        entry.classList.toggle('active', entry === button);
      });
      document.querySelectorAll('[data-pane]').forEach((pane) => {
        pane.hidden = pane.getAttribute('data-pane') !== button.getAttribute('data-tab');
      });
    });
  });
</script>`;
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
