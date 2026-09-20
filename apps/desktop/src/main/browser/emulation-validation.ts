/** Compound `emulate` input is validated before any CDP call, so a rejected
 *  command never leaves the page half reset. */
import type { BrowserCommand } from './command';

export type NetworkProfile = {
  offline: boolean;
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
};

const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  fast3g: { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 100_000 },
};

function assertEmulationViewport(command: BrowserCommand): boolean {
  const hasWidth = Number.isFinite(command.width);
  const hasHeight = Number.isFinite(command.height);
  if (hasWidth !== hasHeight) throw new Error('emulate requires width and height together');
  const hasViewport = hasWidth && hasHeight;
  if (
    !hasViewport &&
    [command.deviceScaleFactor, command.mobile, command.orientation].some((value) => value !== undefined)
  ) {
    throw new Error('deviceScaleFactor, mobile, and orientation require width and height');
  }
  return hasViewport;
}

function assertEmulationGeolocation(command: BrowserCommand): boolean {
  const hasLatitude = command.latitude !== undefined;
  const hasLongitude = command.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new Error('emulate geolocation requires latitude and longitude together');
  }
  if (hasLatitude && hasLongitude) {
    const latitude = Number(command.latitude);
    const longitude = Number(command.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      throw new Error('emulate geolocation requires latitude within ±90 and longitude within ±180');
    }
  }
  if (command.accuracy !== undefined && !hasLatitude) {
    throw new Error('emulate accuracy requires latitude and longitude');
  }
  return hasLatitude;
}

function assertEmulationMedia(command: BrowserCommand): void {
  if (command.cpuThrottlingRate !== undefined && !Number.isFinite(Number(command.cpuThrottlingRate))) {
    throw new Error('cpuThrottlingRate must be a finite number');
  }
  if (command.orientation !== undefined && command.orientation !== 'portrait' && command.orientation !== 'landscape') {
    throw new Error('orientation must be portrait or landscape');
  }
  if (command.colorScheme !== undefined && !['auto', 'light', 'dark'].includes(command.colorScheme)) {
    throw new Error('colorScheme must be auto, light, or dark');
  }
}

function assertEmulationHeaders(headers: BrowserCommand['headers']): void {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers must be an object');
  }
  const entries = Object.entries(headers);
  if (
    entries.length > 20 ||
    entries.some(
      ([name, value]) =>
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(name) ||
        typeof value !== 'string' ||
        value.length > 8_192 ||
        /[\r\n]/.test(value)
    )
  ) {
    throw new Error('headers require at most 20 valid names and bounded single-line values');
  }
}

function assertEmulationIdentity(command: BrowserCommand): void {
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
  if (command.userAgent !== undefined && (command.userAgent.length > 2_048 || /[\r\n]/.test(command.userAgent))) {
    throw new Error('userAgent must be at most 2048 characters without line breaks');
  }
  if (command.headers !== undefined) assertEmulationHeaders(command.headers);
}

export function validateEmulationCommand(command: BrowserCommand): {
  hasViewport: boolean;
  networkProfile?: NetworkProfile;
} {
  const hasViewport = assertEmulationViewport(command);
  const hasLatitude = assertEmulationGeolocation(command);
  assertEmulationMedia(command);
  assertEmulationIdentity(command);
  const networkProfile =
    command.networkProfile === undefined ? undefined : NETWORK_PROFILES[String(command.networkProfile).toLowerCase()];
  if (command.networkProfile !== undefined && !networkProfile) {
    throw new Error('networkProfile must be none, offline, slow3g, or fast3g');
  }
  const hasAction =
    command.reset === true ||
    hasViewport ||
    hasLatitude ||
    [
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
      'emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, ' +
        'media, CPU, network, geolocation, or headers setting'
    );
  }
  return { hasViewport, networkProfile };
}
