import fs from 'node:fs';

// The page-world sources the core's browser engine ships; the desktop's page scripts are copies of them.
export const ASSETS = new URL('../../../../../native/core/crates/mixdog-browser-engine/assets/page/', import.meta.url);
export const asset = (name) => fs.readFileSync(new URL(name, ASSETS), 'utf8');
