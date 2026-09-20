/** Each emulation switch is one CDP override. These apply them in the order
 *  the `emulate` command defines and return a label for what changed. */
import type { WebContents } from 'electron';

import type { BrowserCdpPort } from './cdp';
import type { BrowserCommand } from './command';
import type { NetworkProfile } from './emulation-validation';

export async function resetEmulation(cdp: BrowserCdpPort, guest: WebContents, signal?: AbortSignal): Promise<void> {
  await Promise.all([
    cdp.call(guest, 'Emulation.clearDeviceMetricsOverride', {}, signal),
    cdp.call(guest, 'Emulation.setTouchEmulationEnabled', { enabled: false }, signal),
    cdp.call(guest, 'Network.setUserAgentOverride', { userAgent: '' }, signal),
    cdp.call(guest, 'Emulation.setTimezoneOverride', { timezoneId: '' }, signal),
    cdp.call(guest, 'Emulation.setLocaleOverride', { locale: '' }, signal),
    cdp.call(guest, 'Emulation.setEmulatedMedia', { features: [] }, signal),
    cdp.call(guest, 'Emulation.setCPUThrottlingRate', { rate: 1 }, signal),
    cdp.call(
      guest,
      'Network.emulateNetworkConditions',
      {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      },
      signal
    ),
    cdp.call(guest, 'Emulation.clearGeolocationOverride', {}, signal),
    cdp.call(guest, 'Network.setExtraHTTPHeaders', { headers: {} }, signal),
  ]);
}

export async function applyViewportOverride(
  cdp: BrowserCdpPort,
  guest: WebContents,
  command: BrowserCommand,
  signal?: AbortSignal
): Promise<{ label: string; viewport: { width: number; height: number } }> {
  const width = Math.min(3840, Math.max(200, Math.trunc(command.width as number)));
  const height = Math.min(3840, Math.max(200, Math.trunc(command.height as number)));
  const deviceScaleFactor = Math.min(
    4,
    Math.max(0.5, Number.isFinite(command.deviceScaleFactor) ? Number(command.deviceScaleFactor) : 1)
  );
  const landscape = command.orientation === 'landscape';
  await cdp.call(
    guest,
    'Emulation.setDeviceMetricsOverride',
    {
      width,
      height,
      deviceScaleFactor,
      mobile: command.mobile === true,
      screenWidth: width,
      screenHeight: height,
      screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    },
    signal
  );
  return {
    label: `${width}x${height}@${deviceScaleFactor}${command.mobile ? ' mobile' : ''}`,
    viewport: { width, height },
  };
}

/** A locale only JavaScript reports leaves requests asking for the old
 *  language, so the page negotiates content the emulation contradicts. A
 *  caller-supplied user agent already carried it in its own call. */
async function applyLocaleOverride(
  cdp: BrowserCdpPort,
  guest: WebContents,
  command: BrowserCommand,
  signal?: AbortSignal
): Promise<void> {
  await cdp.call(guest, 'Emulation.setLocaleOverride', { locale: command.locale }, signal);
  if (command.userAgent === undefined) {
    await cdp.call(
      guest,
      'Network.setUserAgentOverride',
      {
        userAgent: guest.getUserAgent(),
        ...(command.locale ? { acceptLanguage: command.locale } : {}),
      },
      signal
    );
  }
}

/** Touch, user agent, locale and timezone, in command order. */
export async function applyIdentityOverrides(
  cdp: BrowserCdpPort,
  guest: WebContents,
  command: BrowserCommand,
  signal?: AbortSignal
): Promise<string[]> {
  const applied: string[] = [];
  if (command.touch !== undefined) {
    await cdp.call(
      guest,
      'Emulation.setTouchEmulationEnabled',
      { enabled: command.touch, maxTouchPoints: command.touch ? 5 : 1 },
      signal
    );
    applied.push(`touch=${command.touch}`);
  }
  if (command.userAgent !== undefined) {
    await cdp.call(
      guest,
      'Network.setUserAgentOverride',
      {
        userAgent: command.userAgent,
        ...(command.locale ? { acceptLanguage: command.locale } : {}),
      },
      signal
    );
    applied.push('userAgent');
  }
  if (command.locale !== undefined) {
    await applyLocaleOverride(cdp, guest, command, signal);
    applied.push(`locale=${command.locale || 'default'}`);
  }
  if (command.timezone !== undefined) {
    await cdp.call(guest, 'Emulation.setTimezoneOverride', { timezoneId: command.timezone }, signal);
    applied.push(`timezone=${command.timezone || 'default'}`);
  }
  return applied;
}

/** Media preferences, CPU throttling and network conditions, in command order. */
export async function applyPreferenceOverrides(
  cdp: BrowserCdpPort,
  guest: WebContents,
  command: BrowserCommand,
  networkProfile: NetworkProfile | undefined,
  signal?: AbortSignal
): Promise<string[]> {
  const applied: string[] = [];
  if (command.colorScheme || command.reducedMotion !== undefined) {
    const features: Array<{ name: string; value: string }> = [];
    if (command.colorScheme && command.colorScheme !== 'auto') {
      features.push({ name: 'prefers-color-scheme', value: command.colorScheme });
    }
    if (command.reducedMotion !== undefined) {
      features.push({
        name: 'prefers-reduced-motion',
        value: command.reducedMotion ? 'reduce' : 'no-preference',
      });
    }
    await cdp.call(guest, 'Emulation.setEmulatedMedia', { features }, signal);
    applied.push('media');
  }
  if (command.cpuThrottlingRate !== undefined) {
    const rate = Math.min(20, Math.max(1, Number(command.cpuThrottlingRate)));
    await cdp.call(guest, 'Emulation.setCPUThrottlingRate', { rate }, signal);
    applied.push(`cpu=${rate}x`);
  }
  if (command.networkProfile !== undefined) {
    await cdp.call(guest, 'Network.emulateNetworkConditions', networkProfile, signal);
    applied.push(`network=${command.networkProfile}`);
  }
  return applied;
}

/** Geolocation and extra request headers, in command order. */
export async function applyContextOverrides(
  cdp: BrowserCdpPort,
  guest: WebContents,
  command: BrowserCommand,
  signal?: AbortSignal
): Promise<string[]> {
  const applied: string[] = [];
  if (command.latitude !== undefined && command.longitude !== undefined) {
    const latitude = Number(command.latitude);
    const longitude = Number(command.longitude);
    const accuracy = Math.min(10_000, Math.max(1, Number.isFinite(command.accuracy) ? Number(command.accuracy) : 10));
    await cdp.call(guest, 'Emulation.setGeolocationOverride', { latitude, longitude, accuracy }, signal);
    applied.push(`geolocation=${latitude},${longitude}`);
  }
  if (command.headers !== undefined) {
    // Chromium keeps one override set per page, so a later call replaces the
    // previous headers rather than merging into them.
    const headers = command.headers;
    await cdp.call(guest, 'Network.setExtraHTTPHeaders', { headers }, signal);
    const names = Object.keys(headers);
    applied.push(names.length ? `headers=${names.join(',')}` : 'headers cleared');
  }
  return applied;
}
