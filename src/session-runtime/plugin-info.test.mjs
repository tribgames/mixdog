import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { pluginManifest } from '../runtime/shared/plugin-manifest.mjs';
import { addPlugin, listRegisteredPlugins, pluginAdminStatus } from '../standalone/plugin-admin.mjs';
import { createCwdPlugins } from './cwd-plugins.mjs';

const emptyMetadata = { author: '', homepage: '', repository: '', license: '', keywords: [] };
function metadata(plugin) {
  return Object.fromEntries(Object.keys(emptyMetadata).map((key) => [key, plugin[key]]));
}

for (const { name, manifest, expected } of [
  {
    name: 'string metadata',
    manifest: {
      author: ' Example Author ',
      homepage: ' https://example.test ',
      repository: ' https://example.test/plugin.git ',
      license: ' MIT ',
      keywords: [' tools ', 'mcp'],
    },
    expected: {
      author: 'Example Author',
      homepage: 'https://example.test',
      repository: 'https://example.test/plugin.git',
      license: 'MIT',
      keywords: ['tools', 'mcp'],
    },
  },
  {
    name: 'structured metadata',
    manifest: {
      author: { name: ' Author ', email: ' author@example.test ', url: ' https://example.test/author ' },
      homepage: 'https://example.test',
      repository: { type: 'git', url: ' https://example.test/repo.git ' },
      license: { type: ' Apache-2.0 ' },
      keywords: ' developer tools ',
    },
    expected: {
      author: 'Author <author@example.test> https://example.test/author',
      homepage: 'https://example.test',
      repository: 'https://example.test/repo.git',
      license: 'Apache-2.0',
      keywords: ['developer tools'],
    },
  },
  {
    name: 'missing metadata',
    manifest: {},
    expected: emptyMetadata,
  },
  {
    name: 'malformed metadata',
    manifest: {
      author: { name: {}, email: false, url: 7 },
      homepage: {},
      repository: { url: [] },
      license: false,
      keywords: [' tools ', null, {}, false, 42, '  '],
    },
    expected: { ...emptyMetadata, keywords: ['tools'] },
  },
]) {
  test(`plugin registry and session expose ${name} and refresh removed fields`, () => {
    const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-info-'));
    const root = join(base, 'plugin');
    const dataDir = join(base, 'data');
    const manifestPath = join(root, 'plugin.json');
    try {
      mkdirSync(root);
      writeFileSync(manifestPath, JSON.stringify({ name: 'info-test', version: '1.2.3', ...manifest }));
      addPlugin(root, { dataDir });
      const { pluginsStatus } = createCwdPlugins({
        getConfig: () => ({}),
        cfgMod: { getPluginData: () => dataDir },
        listRegisteredPlugins,
        pluginAdminStatus,
        pluginManifest,
        pluginMcpServerName: (plugin) => `plugin-${plugin.id}`,
        countSkillFiles: () => 0,
        clean: (value) => String(value || '').trim(),
        resolve,
        statSync,
        existsSync,
      });
      const registered = listRegisteredPlugins({ dataDir })[0];
      const status = pluginsStatus().plugins[0];
      assert.deepEqual(metadata(registered), expected);
      assert.deepEqual(metadata(status), expected);
      assert.equal(status.version, '1.2.3');
      assert.equal(status.root, root);
      assert.equal(status.sourceUrl, root);

      // A manifest edit must clear old display metadata, including cached status.
      const nextTime = new Date(statSync(manifestPath).mtimeMs + 2000);
      writeFileSync(manifestPath, JSON.stringify({ name: 'info-test' }));
      utimesSync(manifestPath, nextTime, nextTime);
      assert.deepEqual(metadata(listRegisteredPlugins({ dataDir })[0]), emptyMetadata);
      assert.deepEqual(metadata(pluginsStatus().plugins[0]), emptyMetadata);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
