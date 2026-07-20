// "Remote Access" window: one glanceable card with the phone pairing QRs.
// Left QR opens the web app in a phone browser (LAN URL + token); right QR
// deep-links the installed Android app (mixdog://pair) so nothing is typed.
import { BrowserWindow } from 'electron';
import QRCode from 'qrcode';

import type { DesktopRemoteAccessInfo } from '../shared/contract';
import type { RemoteBridgeHandle } from './remote-bridge';

function preferredUrl(urls: string[]): string {
  // Home-router LAN addresses first: Tailscale/VPN interfaces only work when
  // the phone runs the same overlay network.
  return urls.find((url) => url.includes('//192.168.'))
    || urls.find((url) => url.includes('//10.'))
    || urls[0]
    || '';
}

export async function buildRemoteAccessInfo(bridge: RemoteBridgeHandle): Promise<DesktopRemoteAccessInfo> {
  const origin = preferredUrl(bridge.urls);
  const browserUrl = `${origin}/?token=${encodeURIComponent(bridge.token)}`;
  const appLink = `mixdog://pair?server=${encodeURIComponent(origin)}&token=${encodeURIComponent(bridge.token)}`;
  const apkUrl = `${origin}/mixdog.apk`;
  const [browserQr, appQr] = await Promise.all([
    QRCode.toString(browserUrl, { type: 'svg', margin: 1, width: 220, color: { dark: '#1b1a17', light: '#f4f2ee' } }),
    QRCode.toString(appLink, { type: 'svg', margin: 1, width: 220, color: { dark: '#1b1a17', light: '#f4f2ee' } }),
  ]);
  return {
    port: bridge.port,
    urls: bridge.urls,
    browserUrl,
    appLink,
    apkUrl,
    browserQrSvg: browserQr,
    appQrSvg: appQr,
  };
}

export async function showRemoteAccessWindow(
  bridge: RemoteBridgeHandle,
  parent?: BrowserWindow | null,
): Promise<void> {
  const { browserUrl, apkUrl, browserQrSvg: browserQr, appQrSvg: appQr } = await buildRemoteAccessInfo(bridge);
  const html = `<!doctype html><meta charset="utf-8"><title>Remote access</title>
<style>
  body { margin: 0; padding: 28px; background: #201e1c; color: #f4f2ee;
    font: 400 14px/21px system-ui, sans-serif; user-select: text; }
  h1 { margin: 0 0 4px; font-size: 17px; }
  p { margin: 0 0 18px; color: #b3ada3; font-size: 12.5px; line-height: 18px; }
  .grid { display: flex; gap: 20px; }
  .card { flex: 1; display: grid; gap: 10px; justify-items: center;
    padding: 16px 12px; border-radius: 12px; background: #282623; }
  .card b { font-size: 13px; }
  .card svg { width: 200px; height: 200px; border-radius: 8px; }
  .card small { color: #b3ada3; font-size: 11px; text-align: center; }
  code { display: block; margin-top: 16px; padding: 10px 12px; border-radius: 8px;
    overflow-wrap: anywhere; background: #161514; color: #d6d1c8; font-size: 11px; }
</style>
<h1>Phone remote</h1>
<p>Same Wi-Fi as this PC. Scan with the phone camera.</p>
<div class="grid">
  <div class="card"><b>Browser</b>${browserQr}<small>Opens the web app directly</small></div>
  <div class="card"><b>Mixdog app</b>${appQr}<small>Pairs the installed Android app</small></div>
</div>
<code>App install: ${apkUrl}</code>
<code>${browserUrl}</code>`;
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
