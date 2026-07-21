// "Remote Access" window: one glanceable card with the phone pairing QRs.
// Relay-only (works from any network — user decision: no LAN fallback).
// Browser tab QR opens the web app; Android tab QRs install the APK and
// deep-link the installed app (mixdog://pair). Until the relay link is up
// the window shows a connecting note instead of LAN QRs.
import { BrowserWindow } from 'electron';
import QRCode from 'qrcode';

import type { DesktopRemoteAccessInfo } from '../shared/contract';
import type { RemoteBridgeHandle } from './remote-bridge';
import type { RemoteRelayHandle } from './remote-relay';

function preferredUrl(urls: string[]): string {
  // Home-router LAN addresses first: Tailscale/VPN interfaces only work when
  // the phone runs the same overlay network.
  return urls.find((url) => url.includes('//192.168.'))
    || urls.find((url) => url.includes('//10.'))
    || urls[0]
    || '';
}

const qrSvg = (value: string): Promise<string> =>
  QRCode.toString(value, { type: 'svg', margin: 1, width: 220, color: { dark: '#1b1a17', light: '#f4f2ee' } });

export async function buildRemoteAccessInfo(
  bridge: RemoteBridgeHandle,
  relay?: RemoteRelayHandle | null,
): Promise<DesktopRemoteAccessInfo> {
  const origin = preferredUrl(bridge.urls);
  const browserUrl = `${origin}/?token=${encodeURIComponent(bridge.token)}`;
  const appLink = `mixdog://pair?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(bridge.token)}`;
  const apkUrl = `${origin}/mixdog.apk`;
  const [browserQr, appQr] = await Promise.all([qrSvg(browserUrl), qrSvg(appLink)]);
  const info: DesktopRemoteAccessInfo = {
    port: bridge.port,
    urls: bridge.urls,
    browserUrl,
    appLink,
    apkUrl,
    browserQrSvg: browserQr,
    appQrSvg: appQr,
  };
  if (relay) {
    // Relay pairing works from any network; the bridge and relay share one
    // token, so either QR authorizes the same phone.
    const relayOrigin = new URL(relay.clientUrl).origin;
    info.relayBrowserUrl = `${relayOrigin}/?token=${encodeURIComponent(relay.token)}`;
    info.relayAppLink = `mixdog://pair?server=${encodeURIComponent(relayOrigin)}&token=${encodeURIComponent(relay.token)}`;
    info.relayApkUrl = `${relayOrigin}/mixdog.apk`;
    [info.relayBrowserQrSvg, info.relayAppQrSvg] = await Promise.all([
      qrSvg(info.relayBrowserUrl),
      qrSvg(info.relayAppLink),
    ]);
  }
  // Install QR: scanning it downloads the APK directly (no typed URL).
  info.apkQrSvg = await qrSvg(info.relayApkUrl || apkUrl);
  return info;
}

export async function showRemoteAccessWindow(
  bridge: RemoteBridgeHandle,
  relay?: RemoteRelayHandle | null,
  parent?: BrowserWindow | null,
): Promise<void> {
  const info = await buildRemoteAccessInfo(bridge, relay);
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
  body { margin: 0; padding: 28px; background: #201e1c; color: #f4f2ee;
    font: 400 14px/21px system-ui, sans-serif; user-select: text; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  p { margin: 0 0 18px; color: #b3ada3; font-size: 12.5px; line-height: 18px; }
  .tabs { display: flex; justify-content: center; gap: 6px; margin: 0 0 18px; }
  .tabs button { padding: 7px 16px; border: 0; border-radius: 999px; background: transparent;
    color: #b3ada3; font: 500 13px/18px system-ui, sans-serif; cursor: pointer; }
  .tabs button.active { background: #423e39; color: #f4f2ee; }
  .tabs button:hover { color: #f4f2ee; }
  .grid { display: flex; gap: 20px; }
  .grid.single { justify-content: center; }
  .grid.single .card { max-width: 244px; }
  .card { flex: 1; display: grid; gap: 10px; justify-items: center;
    padding: 16px 12px; border-radius: 12px; background: #282623; }
  .card b { font-size: 13px; }
  .card svg { width: 200px; height: 200px; border-radius: 8px; }
  .card small { color: #b3ada3; font-size: 11px; text-align: center; }
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
  const window = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Remote access',
    backgroundColor: '#201e1c',
    parent: parent ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.setMenuBarVisibility(false);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
