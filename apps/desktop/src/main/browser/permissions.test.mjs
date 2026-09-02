import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearBrowserPermissionHandlers,
  lockDownBrowserPermissions,
} from './permissions.ts';

test('Browser Use denies site and physical-device permissions by default', () => {
  const handlers = {};
  lockDownBrowserPermissions({
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setDevicePermissionHandler(handler) {
      handlers.device = handler;
    },
  });

  assert.equal(handlers.check(), false);
  let permissionGranted;
  handlers.request({}, 'media', (granted) => {
    permissionGranted = granted;
  });
  assert.equal(permissionGranted, false);
  assert.equal(handlers.device({ deviceType: 'usb' }), false);
  clearBrowserPermissionHandlers({
    setPermissionCheckHandler(handler) {
      handlers.check = handler;
    },
    setPermissionRequestHandler(handler) {
      handlers.request = handler;
    },
    setDevicePermissionHandler(handler) {
      handlers.device = handler;
    },
  });
  assert.equal(handlers.check, null);
  assert.equal(handlers.request, null);
  assert.equal(handlers.device, null);
});
