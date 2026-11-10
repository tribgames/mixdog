import { readFileSync } from 'node:fs';

/** The installed package version, for the MCP server identity and the fetch User-Agent. */
export const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')).version || '0.0.1';
  } catch {
    return '0.0.1';
  }
})();
