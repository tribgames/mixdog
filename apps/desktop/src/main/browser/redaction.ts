/**
 * Secret detection and redaction for every string that leaves the browser
 * host: page text, URLs, network bodies, dialog messages, and errors. The rules
 * are Rust (native/core/crates/mixdog-browser-rules), served synchronously
 * through the Node-API module mixdog_main_native.node (native/mixdog-main-native,
 * every platform), loaded at the first call by native-module.ts; this file holds
 * the types and the exports, no rule. url-policy.ts shares the loaded module.
 */
import { cargoLibraryFile, loadNativeModule, type NativeModuleSpec, nativeModulePath } from '../native-module';

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

/** The functions of native/mixdog-main-native/src/browser_policy.rs. */
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

/** These are safety rules: a module that cannot be loaded must not let a URL through unchecked or a secret out
 *  unredacted, so a failure to load it at first use is fatal (native-module.ts names the file). */
export const browserPolicyModule: NativeModuleSpec<BrowserPolicyModule> = {
  crate: 'mixdog-main-native',
  packagedFile: 'mixdog_main_native.node',
  builtFile: (platform) => cargoLibraryFile('mixdog_main_native', platform),
  check(exports) {
    // A stale build without these functions is as unusable as a missing one.
    if (typeof exports.redactBrowserText !== 'function' || typeof exports.normalizePageUrl !== 'function') {
      throw new Error('the module does not export the browser policy functions');
    }
  },
};

/** Where the module file is (a test skips when it is not there). */
export const browserPolicyModulePath = (): string => nativeModulePath(browserPolicyModule);

export const browserPolicy = (): BrowserPolicyModule => loadNativeModule(browserPolicyModule);

export function browserUrlContainsSecret(raw: string): boolean {
  return browserPolicy().browserUrlContainsSecret(String(raw || ''));
}

export function redactBrowserText(value: unknown): string {
  return browserPolicy().redactBrowserText(String(value ?? ''));
}

export function redactBrowserKnownSecrets(value: string, secrets: Iterable<string>): string {
  return browserPolicy().redactBrowserKnownSecrets(value, Array.from(secrets));
}

export function redactBrowserUrl(value: unknown): string {
  return browserPolicy().redactBrowserUrl(String(value ?? ''));
}
