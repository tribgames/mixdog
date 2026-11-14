/**
 * Secret detection and redaction for every string that leaves the browser
 * host: page text, URLs, network bodies, dialog messages, and errors. The rules
 * are Rust (native/core/crates/mixdog-browser-policy), served synchronously
 * through the Node-API module mixdog_window.node; this file holds the loader
 * and the exports, no rule. url-policy.ts shares the loaded module.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { micaLibraryPath } from '../window-mica';

export interface BrowserUrlPolicy {
  allowPrivateNetwork?: boolean;
  allowedDomains?: string[];
}

/** Runtime-set on a navigate, never a tool argument (runtime
 *  browser-bridge/mail-links.mjs): `url` appeared in a mail from `from_domain`
 *  that the runtime read through its mailbox connector for this session at
 *  `read_at` (ms since the epoch). */
export interface BrowserMailLink {
  url: string;
  from_domain: string;
  read_at: number;
}

/** The functions of native/mixdog-window/src/browser_policy.rs. */
export interface BrowserPolicyModule {
  mailLinkWindowMs(): number;
  isLoopbackHostname(hostname: string): boolean;
  normalizeAgentUrl(raw: string, policy?: BrowserUrlPolicy, mailLink?: BrowserMailLink): string;
  normalizePageUrl(raw: string, policy?: BrowserUrlPolicy): string;
  assertResolvedAddressAllowed(address: string, hostname: string, policy?: BrowserUrlPolicy): void;
  browserUrlContainsSecret(raw: string): boolean;
  redactBrowserText(value: string): string;
  redactBrowserKnownSecrets(value: string, secrets: string[]): string;
  redactBrowserUrl(value: string): string;
}

/** Where the module is: the packaged copy in resources/native-tools, else the
 *  dev build of the checkout this file is in (window-mica.ts `micaLibraryPath`). */
function browserPolicyLibrary(): string {
  if (process.versions.electron && !process.defaultApp) {
    return micaLibraryPath({ isPackaged: true, resourcesPath: process.resourcesPath, appPath: '' });
  }
  let root = import.meta.dirname;
  while (!existsSync(join(root, 'native', 'mixdog-window', 'Cargo.toml'))) {
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return micaLibraryPath({ isPackaged: false, resourcesPath: '', appPath: join(root, 'apps', 'desktop') });
}

/** These are safety rules: a module that cannot be loaded must not let a URL
 *  through unchecked or a secret out unredacted, so loading it is part of
 *  startup and its failure stops the process with the module named. */
function loadBrowserPolicy(): BrowserPolicyModule {
  const library = browserPolicyLibrary();
  try {
    const module = { exports: {} as BrowserPolicyModule };
    process.dlopen(module as NodeJS.Module, library);
    // A stale build without these functions is as unusable as a missing one.
    if (typeof module.exports.redactBrowserText !== 'function' || typeof module.exports.normalizePageUrl !== 'function') {
      throw new Error('the module does not export the browser policy functions');
    }
    return module.exports;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[mixdog-window] The browser URL policy and redaction module mixdog_window.node could not be loaded from ${library}: ${message}. ` +
        'Browser Use cannot run without it.'
    );
  }
}

export const browserPolicy: BrowserPolicyModule = loadBrowserPolicy();

export function browserUrlContainsSecret(raw: string): boolean {
  return browserPolicy.browserUrlContainsSecret(String(raw || ''));
}

export function redactBrowserText(value: unknown): string {
  return browserPolicy.redactBrowserText(String(value ?? ''));
}

export function redactBrowserKnownSecrets(value: string, secrets: Iterable<string>): string {
  return browserPolicy.redactBrowserKnownSecrets(value, Array.from(secrets));
}

export function redactBrowserUrl(value: unknown): string {
  return browserPolicy.redactBrowserUrl(String(value ?? ''));
}
