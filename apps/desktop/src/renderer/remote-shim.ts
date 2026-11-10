// Browser-mode DesktopApi entry: when the Relay serves this page to a phone/tablet, install the protocol-client-backed
// window.mixdogDesktop before any module reads it (remote-shim-boot.ts). Inside Electron the preload bridge already exists and
// this is a no-op. Every `remote-protocol-<group>.ts` next to this file is an adapter and is found here without registration.
import { bundledPhoneAdapters } from './remote-shim-adapters';
import { installPhoneShim } from './remote-shim-boot';

installPhoneShim(bundledPhoneAdapters());
