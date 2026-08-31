/**
 * Device emulation: viewport, touch, user agent, locale, timezone, media
 * preferences, CPU, and network conditions. Every switch is one CDP override,
 * so this only needs a way to talk CDP and a way to report the page afterwards.
 */
import type { WebContents } from 'electron';

import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserSnapshotResultOptions,
} from './browser-host';

const NETWORK_PROFILES: Record<string, {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  fast3g: { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 100_000 },
};

export interface BrowserEmulationHost {
  guestDebugger(guest: WebContents): Promise<Electron.Debugger>;
  sendCdp<T>(
    guest: WebContents,
    cdp: Electron.Debugger,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  /** An override changes the page, so refs taken before it are no longer safe. */
  invalidateInteractionState(guest: WebContents): void;
  snapshotResult(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
    options?: BrowserSnapshotResultOptions,
  ): Promise<BrowserCommandResult>;
  cdpTimeoutMs: number;
}

function validateEmulationCommand(command: BrowserCommand): {
  hasViewport: boolean;
  networkProfile?: (typeof NETWORK_PROFILES)[string];
} {
  const hasWidth = Number.isFinite(command.width);
  const hasHeight = Number.isFinite(command.height);
  if (hasWidth !== hasHeight) throw new Error('emulate requires width and height together');
  const hasViewport = hasWidth && hasHeight;
  if (!hasViewport && [
    command.deviceScaleFactor,
    command.mobile,
    command.orientation,
  ].some((value) => value !== undefined)) {
    throw new Error('deviceScaleFactor, mobile, and orientation require width and height');
  }

  const hasLatitude = command.latitude !== undefined;
  const hasLongitude = command.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new Error('emulate geolocation requires latitude and longitude together');
  }
  if (hasLatitude && hasLongitude) {
    const latitude = Number(command.latitude);
    const longitude = Number(command.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new Error('emulate geolocation requires latitude within ±90 and longitude within ±180');
    }
  }
  if (command.accuracy !== undefined && !hasLatitude) {
    throw new Error('emulate accuracy requires latitude and longitude');
  }
  if (command.cpuThrottlingRate !== undefined
    && !Number.isFinite(Number(command.cpuThrottlingRate))) {
    throw new Error('cpuThrottlingRate must be a finite number');
  }
  if (command.orientation !== undefined
    && command.orientation !== 'portrait'
    && command.orientation !== 'landscape') {
    throw new Error('orientation must be portrait or landscape');
  }
  if (command.colorScheme !== undefined
    && !['auto', 'light', 'dark'].includes(command.colorScheme)) {
    throw new Error('colorScheme must be auto, light, or dark');
  }
  if (command.locale) {
    try {
      new Intl.Locale(command.locale);
    } catch {
      throw new Error('locale must be a valid BCP 47 locale');
    }
  }
  if (command.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: command.timezone }).format();
    } catch {
      throw new Error('timezone must be a valid IANA timezone');
    }
  }
  if (command.userAgent !== undefined
    && (command.userAgent.length > 2_048 || /[\r\n]/.test(command.userAgent))) {
    throw new Error('userAgent must be at most 2048 characters without line breaks');
  }
  if (command.headers !== undefined) {
    if (!command.headers || typeof command.headers !== 'object'
      || Array.isArray(command.headers)) {
      throw new Error('headers must be an object');
    }
    const entries = Object.entries(command.headers);
    if (entries.length > 20 || entries.some(([name, value]) => (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(name)
      || typeof value !== 'string'
      || value.length > 8_192
      || /[\r\n]/.test(value)
    ))) {
      throw new Error('headers require at most 20 valid names and bounded single-line values');
    }
  }
  const networkProfile = command.networkProfile === undefined
    ? undefined
    : NETWORK_PROFILES[String(command.networkProfile).toLowerCase()];
  if (command.networkProfile !== undefined && !networkProfile) {
    throw new Error('networkProfile must be none, offline, slow3g, or fast3g');
  }
  const hasAction = command.reset === true
    || hasViewport
    || hasLatitude
    || [
      command.touch,
      command.userAgent,
      command.locale,
      command.timezone,
      command.colorScheme,
      command.reducedMotion,
      command.cpuThrottlingRate,
      command.networkProfile,
      command.headers,
    ].some((value) => value !== undefined);
  if (!hasAction) {
    throw new Error(
      'emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, '
      + 'media, CPU, network, geolocation, or headers setting',
    );
  }
  return { hasViewport, networkProfile };
}

export function createBrowserEmulation(host: BrowserEmulationHost) {
  const {
    guestDebugger,
    sendCdp,
    invalidateInteractionState,
    snapshotResult,
    cdpTimeoutMs,
  } = host;

  async function applyEmulation(
    guest: WebContents,
    command: BrowserCommand,
    signal?: AbortSignal,
    options: BrowserSnapshotResultOptions = {},
  ): Promise<BrowserCommandResult> {
    const validated = validateEmulationCommand(command);
    const cdp = await guestDebugger(guest);
    const applied: string[] = [];
    if (command.reset) {
      await Promise.all([
        sendCdp(guest, cdp, 'Emulation.clearDeviceMetricsOverride', {}, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.setTouchEmulationEnabled', { enabled: false }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Network.setUserAgentOverride', { userAgent: '' }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.setTimezoneOverride', { timezoneId: '' }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.setLocaleOverride', { locale: '' }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.setEmulatedMedia', { features: [] }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.setCPUThrottlingRate', { rate: 1 }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Network.emulateNetworkConditions', {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Emulation.clearGeolocationOverride', {}, cdpTimeoutMs, signal),
        sendCdp(guest, cdp, 'Network.setExtraHTTPHeaders', { headers: {} }, cdpTimeoutMs, signal),
      ]);
      applied.push('reset');
    }
    if (validated.hasViewport) {
      const width = Math.min(3840, Math.max(200, Math.trunc(command.width as number)));
      const height = Math.min(3840, Math.max(200, Math.trunc(command.height as number)));
      const deviceScaleFactor = Math.min(
        4,
        Math.max(0.5, Number.isFinite(command.deviceScaleFactor) ? Number(command.deviceScaleFactor) : 1),
      );
      const landscape = command.orientation === 'landscape';
      await sendCdp(guest, cdp, 'Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: command.mobile === true,
        screenWidth: width,
        screenHeight: height,
        screenOrientation: landscape
          ? { type: 'landscapePrimary', angle: 90 }
          : { type: 'portraitPrimary', angle: 0 },
      }, cdpTimeoutMs, signal);
      applied.push(`${width}x${height}@${deviceScaleFactor}${command.mobile ? ' mobile' : ''}`);
    }
    if (command.touch !== undefined) {
      await sendCdp(guest, cdp, 'Emulation.setTouchEmulationEnabled', {
        enabled: command.touch,
        maxTouchPoints: command.touch ? 5 : 1,
      }, cdpTimeoutMs, signal);
      applied.push(`touch=${command.touch}`);
    }
    if (command.userAgent !== undefined) {
      await sendCdp(guest, cdp, 'Network.setUserAgentOverride', {
        userAgent: command.userAgent,
        ...(command.locale ? { acceptLanguage: command.locale } : {}),
      }, cdpTimeoutMs, signal);
      applied.push('userAgent');
    }
    if (command.locale !== undefined) {
      await sendCdp(guest, cdp, 'Emulation.setLocaleOverride', {
        locale: command.locale,
      }, cdpTimeoutMs, signal);
      applied.push(`locale=${command.locale || 'default'}`);
    }
    if (command.timezone !== undefined) {
      await sendCdp(guest, cdp, 'Emulation.setTimezoneOverride', {
        timezoneId: command.timezone,
      }, cdpTimeoutMs, signal);
      applied.push(`timezone=${command.timezone || 'default'}`);
    }
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
      await sendCdp(guest, cdp, 'Emulation.setEmulatedMedia', {
        features,
      }, cdpTimeoutMs, signal);
      applied.push('media');
    }
    if (command.cpuThrottlingRate !== undefined) {
      const rate = Math.min(20, Math.max(1, Number(command.cpuThrottlingRate)));
      await sendCdp(guest, cdp, 'Emulation.setCPUThrottlingRate', {
        rate,
      }, cdpTimeoutMs, signal);
      applied.push(`cpu=${rate}x`);
    }
    if (command.networkProfile !== undefined) {
      await sendCdp(
        guest,
        cdp,
        'Network.emulateNetworkConditions',
        validated.networkProfile,
        cdpTimeoutMs,
        signal,
      );
      applied.push(`network=${command.networkProfile}`);
    }
    if (command.latitude !== undefined && command.longitude !== undefined) {
      const latitude = Number(command.latitude);
      const longitude = Number(command.longitude);
      const accuracy = Math.min(10_000, Math.max(
        1,
        Number.isFinite(command.accuracy) ? Number(command.accuracy) : 10,
      ));
      await sendCdp(guest, cdp, 'Emulation.setGeolocationOverride', {
        latitude,
        longitude,
        accuracy,
      }, cdpTimeoutMs, signal);
      applied.push(`geolocation=${latitude},${longitude}`);
    }
    if (command.headers !== undefined) {
      // Chromium keeps one override set per page, so a later call replaces the
      // previous headers rather than merging into them.
      const headers = command.headers;
      await sendCdp(guest, cdp, 'Network.setExtraHTTPHeaders', { headers }, cdpTimeoutMs, signal);
      const names = Object.keys(headers);
      applied.push(names.length ? `headers=${names.join(',')}` : 'headers cleared');
    }
    if (!applied.length) {
      throw new Error('emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, media, CPU, network, geolocation, or headers setting');
    }
    invalidateInteractionState(guest);
    const snapshot = await snapshotResult(guest, command, signal, {
      ...options,
      settleAction: true,
    });
    return {
      ...snapshot,
      text: `Emulation configured: ${applied.join(', ')}\n\n${snapshot.text}`,
    };
  }

  return { applyEmulation };
}
