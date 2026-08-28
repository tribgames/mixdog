/// <reference types="vite/client" />

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from '../chrome-extension/manifest.json?raw';
import popupCss from '../chrome-extension/popup.css?raw';
import popupHtml from '../chrome-extension/popup.html?raw';
import popupJs from '../chrome-extension/popup.js?raw';
import purchasePolicy from '../chrome-extension/purchase-policy.js?raw';
import serviceWorker from '../chrome-extension/service-worker.js?raw';

const FILES: Readonly<Record<string, string>> = {
  'manifest.json': manifest,
  'popup.css': popupCss,
  'popup.html': popupHtml,
  'popup.js': popupJs,
  'purchase-policy.js': purchasePolicy,
  'service-worker.js': serviceWorker,
};

export function materializeBrowserExtension(userDataDirectory: string): string {
  const extensionPath = join(userDataDirectory, 'chrome-extension');
  mkdirSync(extensionPath, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) {
    const path = join(extensionPath, name);
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // Create the missing extension file below.
    }
    if (current !== content) writeFileSync(path, content, 'utf8');
  }
  return extensionPath;
}
