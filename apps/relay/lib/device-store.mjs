// Device credentials facade; persistence and client lifecycle live in their
// responsibility-specific modules.
import { join } from 'node:path';

import {
  authenticateDevice,
  clientAccessForToken,
  clientProfile,
  deviceIdForClientToken,
  listClients,
  readDeviceCredentials,
  registerClient,
  registrableDeviceId,
  revokeClient,
  revokeDevice,
  setClientToken,
  touchClient,
} from './device-store-auth.mjs';
import {
  buildTokenIndexes,
  loadDeviceStore,
  saveDeviceStore,
  saveOrLog,
  scheduleSave,
} from './device-store-persistence.mjs';

export { clientProfile, readDeviceCredentials, registrableDeviceId };

export class DeviceStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'devices.json');
    this.devices = loadDeviceStore(this.path);
    ({ tokenIndex: this.tokenIndex, clientTokenIndex: this.clientTokenIndex } = buildTokenIndexes(this.devices));
    this.saveTimer = null;
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    saveDeviceStore(this);
  }

  saveOrLog() {
    return saveOrLog(this);
  }

  scheduleSave() {
    scheduleSave(this);
  }

  isKnown(deviceId) {
    return this.devices.has(deviceId);
  }

  authenticate(deviceId, secret) {
    return authenticateDevice(this, deviceId, secret);
  }

  setClientToken(deviceId, token) {
    return setClientToken(this, deviceId, token);
  }

  revoke(deviceId) {
    return revokeDevice(this, deviceId);
  }

  deviceIdForClientToken(token) {
    return deviceIdForClientToken(this, token);
  }

  clientAccessForToken(token) {
    return clientAccessForToken(this, token);
  }

  registerClient(deviceId, clientId, profile = {}) {
    return registerClient(this, deviceId, clientId, profile);
  }

  touchClient(deviceId, clientId, profile = {}) {
    return touchClient(this, deviceId, clientId, profile);
  }

  listClients(deviceId, online = new Set()) {
    return listClients(this, deviceId, online);
  }

  revokeClient(deviceId, clientId) {
    return revokeClient(this, deviceId, clientId);
  }
}
