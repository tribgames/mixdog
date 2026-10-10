// The desktop version a device last reported on its leg, persisted with the
// device row so a relay restart still routes phones to the right renderer
// release before the desktop has redialed. Old desktops never report one.
import { DESKTOP_VERSION, SHELL_VERSION } from './renderer-releases.mjs';

// A fleet redial must not rewrite devices.json per desktop for a value that did
// not change; the timestamp only needs to stay fresh enough for retention.
const SEEN_REFRESH_MS = 60 * 60 * 1000;

function cleanReport(report) {
  const appVersion = DESKTOP_VERSION.test(String(report?.appVersion || '')) ? String(report.appVersion) : '';
  const rendererRelease = SHELL_VERSION.test(String(report?.rendererRelease || '')) ? String(report.rendererRelease) : '';
  return { appVersion, rendererRelease };
}

/** Drop unusable version fields from a row loaded off disk. */
export function applyStoredVersion(row) {
  const { appVersion, rendererRelease } = cleanReport(row);
  if (!appVersion) {
    delete row.appVersion;
    delete row.rendererRelease;
    delete row.versionSeenAt;
    return;
  }
  row.appVersion = appVersion;
  if (rendererRelease) row.rendererRelease = rendererRelease;
  else delete row.rendererRelease;
  row.versionSeenAt = Number.isFinite(row.versionSeenAt) ? row.versionSeenAt : Date.now();
}

/** { appVersion, rendererRelease } for routing; empty strings when unknown. */
export function deviceVersion(store, deviceId) {
  const row = store.devices.get(deviceId);
  return row ? cleanReport(row) : { appVersion: '', rendererRelease: '' };
}

/** False when the report is unusable (no valid app version). */
export function recordDesktopVersion(store, deviceId, report, now = Date.now()) {
  const row = store.devices.get(deviceId);
  const { appVersion, rendererRelease } = cleanReport(report);
  if (!row || !appVersion) return false;
  const unchanged = row.appVersion === appVersion && (row.rendererRelease || '') === rendererRelease;
  if (unchanged && now - (row.versionSeenAt || 0) < SEEN_REFRESH_MS) return true;
  row.appVersion = appVersion;
  if (rendererRelease) row.rendererRelease = rendererRelease;
  else delete row.rendererRelease;
  row.versionSeenAt = now;
  store.scheduleSave();
  return true;
}
