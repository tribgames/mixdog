import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { resolveContainedPluginPath } from '../../../shared/plugin-manifest.mjs';
import { discoverPluginMcp, loadPluginMcpDeclarations, pluginMcpDeclarationCacheStats } from './plugin-mcp.mjs';

function plugin(files) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-decl-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function withPlugin(files, fn) {
  const root = plugin(files);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const stdio = (command) => ({ command });
const keys = (r) => r.servers.map((s) => s.key);

test('format follows the first manifest found, else .mcp.json, else none', () => {
  withPlugin({ '.codex-plugin/plugin.json': {}, 'plugin.json': {}, '.claude-plugin/plugin.json': {} }, (r) =>
    assert.equal(loadPluginMcpDeclarations(r).format, 'codex')
  );
  withPlugin({ 'plugin.json': {}, '.claude-plugin/plugin.json': {} }, (r) =>
    assert.equal(loadPluginMcpDeclarations(r).format, 'mixdog')
  );
  withPlugin({ '.claude-plugin/plugin.json': {} }, (r) => assert.equal(loadPluginMcpDeclarations(r).format, 'claude'));
  withPlugin({ '.mcp.json': { a: stdio('x') } }, (r) => assert.equal(loadPluginMcpDeclarations(r).format, 'claude'));
  withPlugin({ 'readme.md': 'x' }, (r) =>
    assert.deepEqual(loadPluginMcpDeclarations(r), { format: 'none', servers: [], errors: [] })
  );
});

test('.mcp.json accepts wrapper and bare map, configs stay raw', () => {
  withPlugin({ '.mcp.json': { mcpServers: { a: { command: '${CLAUDE_PLUGIN_ROOT}/x', cwd: 'rel' } } } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.servers, [
      { key: 'a', config: { command: '${CLAUDE_PLUGIN_ROOT}/x', cwd: 'rel' }, source: join(r, '.mcp.json') },
    ]);
  });
  withPlugin({ '.mcp.json': { a: stdio('x'), b: { type: 'http', url: 'https://h' } } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(keys(out), ['a', 'b']);
    assert.deepEqual(out.errors, []);
  });
});

test('manifest string path, wrapper or bare', () => {
  withPlugin(
    { 'plugin.json': { mcpServers: './m/one.json' }, 'm/one.json': { mcpServers: { a: stdio('x') } } },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(keys(out), ['a']);
      assert.equal(out.servers[0].source, join(r, 'm', 'one.json'));
    }
  );
  withPlugin({ '.codex-plugin/plugin.json': { mcpServers: './one.json' }, 'one.json': { a: stdio('x') } }, (r) =>
    assert.deepEqual(keys(loadPluginMcpDeclarations(r)), ['a'])
  );
});

test('manifest array merges in order, last wins by key', () => {
  withPlugin(
    {
      'plugin.json': { mcpServers: ['./a.json', './b.json'] },
      'a.json': { x: stdio('a-x'), y: stdio('a-y') },
      'b.json': { mcpServers: { x: stdio('b-x'), z: stdio('b-z') } },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(out.errors, []);
      assert.deepEqual(keys(out).sort(), ['x', 'y', 'z']);
      assert.equal(out.servers.find((s) => s.key === 'x').config.command, 'b-x');
    }
  );
});

test('inline object accepts wrapper and bare; source is the manifest', () => {
  withPlugin({ 'plugin.json': { mcpServers: { a: stdio('x') } } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(out.servers, [{ key: 'a', config: stdio('x'), source: join(r, 'plugin.json') }]);
  });
  withPlugin({ 'plugin.json': { mcpServers: { mcpServers: { a: stdio('x') } } } }, (r) =>
    assert.deepEqual(keys(loadPluginMcpDeclarations(r)), ['a'])
  );
});

test('.mcp.json then manifest: manifest overrides by key', () => {
  withPlugin(
    {
      '.mcp.json': { a: stdio('file'), keep: stdio('k') },
      '.claude-plugin/plugin.json': { mcpServers: { a: stdio('inline') } },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(out.errors, []);
      assert.equal(out.servers.find((s) => s.key === 'a').config.command, 'inline');
      assert.deepEqual(keys(out).sort(), ['a', 'keep']);
    }
  );
});

test('bad server entries are skipped and reported, siblings load', () => {
  withPlugin(
    {
      '.mcp.json': {
        ok: stdio('x'),
        notObject: 'nope',
        badType: { type: 'carrier-pigeon', command: 'x' },
        noCommand: { type: 'stdio' },
        noCommandDefault: { args: [] },
        httpNoUrl: { type: 'http' },
        streamNoUrl: { type: 'streamable-http' },
        sseNoUrl: { type: 'sse' },
        wsNoUrl: { type: 'ws' },
        ws: { type: 'ws', url: 'wss://h' },
        sse: { type: 'sse', url: 'https://h' },
      },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(keys(out), ['ok', 'ws', 'sse']);
      assert.deepEqual(out.errors.map((e) => e.key).sort(), [
        'badType',
        'httpNoUrl',
        'noCommand',
        'noCommandDefault',
        'notObject',
        'sseNoUrl',
        'streamNoUrl',
        'wsNoUrl',
      ]);
      assert.ok(out.errors.every((e) => e.source === join(r, '.mcp.json') && e.message));
    }
  );
});

test('prefix-less and nested relative paths load', () => {
  withPlugin(
    {
      'plugin.json': { mcpServers: ['mcp.json', './b.json', 'conf/c.json'] },
      'mcp.json': { a: stdio('x') },
      'b.json': { b: stdio('x') },
      'conf/c.json': { c: stdio('x') },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(out.errors, []);
      assert.deepEqual(keys(out), ['a', 'b', 'c']);
    }
  );
});

test('path errors: absolute, absolute, dotdot, escape, missing', () => {
  for (const bad of ['/abs/m.json', 'C:\\abs\\m.json', './../m.json', './a/../../m.json', './a/../m.json']) {
    withPlugin({ 'plugin.json': { mcpServers: [bad, './good.json'] }, 'good.json': { g: stdio('x') } }, (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(keys(out), ['g'], bad);
      assert.equal(out.errors.length, 1, bad);
      assert.equal(out.errors[0].source, join(r, 'plugin.json'));
    });
  }
  withPlugin({ 'plugin.json': { mcpServers: './nope.json' } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].message, /not found/);
  });
});

test('parse failures and shape errors never throw', () => {
  withPlugin({ '.mcp.json': '{ broken', 'plugin.json': { mcpServers: { a: stdio('x') } } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(keys(out), ['a']);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].source, join(r, '.mcp.json'));
    assert.match(out.errors[0].message, /JSON|position|Expected/);
  });
  withPlugin({ '.mcp.json': '[]' }, (r) => assert.equal(loadPluginMcpDeclarations(r).errors.length, 1));
  withPlugin({ '.mcp.json': { mcpServers: [] } }, (r) => assert.equal(loadPluginMcpDeclarations(r).errors.length, 1));
  withPlugin({ 'plugin.json': { mcpServers: 5 } }, (r) => assert.equal(loadPluginMcpDeclarations(r).errors.length, 1));
  withPlugin({ 'plugin.json': { mcpServers: { mcpServers: 5 } } }, (r) =>
    assert.equal(loadPluginMcpDeclarations(r).errors.length, 1)
  );
  withPlugin({ 'plugin.json': '{ nope', '.mcp.json': { a: stdio('x') } }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(keys(out), ['a']);
    assert.equal(out.errors[0].source, join(r, 'plugin.json'));
  });
});

test('a url without a type loads as http, like the client resolves it', () => {
  withPlugin(
    {
      '.mcp.json': {
        web: { url: 'https://h/mcp' },
        legacy: { transport: 'http', url: 'https://h/mcp' },
        cased: { type: 'StreamableHttp', url: 'https://h/mcp' },
        empty: { url: '' },
      },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(keys(out), ['web', 'legacy', 'cased']);
      assert.deepEqual(
        out.errors.map((e) => [e.key, e.message]),
        [['empty', 'http server requires "url"']]
      );
    }
  );
});

test('manifest arrays mix paths and inline maps (bare or wrapped), merged in order', () => {
  withPlugin(
    {
      'plugin.json': {
        mcpServers: ['./a.json', { b: stdio('inline-b'), x: stdio('inline-x') }, { mcpServers: { c: stdio('c') } }, 7],
      },
      'a.json': { x: stdio('file-x') },
    },
    (r) => {
      const out = loadPluginMcpDeclarations(r);
      assert.deepEqual(keys(out), ['x', 'b', 'c']);
      assert.equal(out.servers.find((s) => s.key === 'x').config.command, 'inline-x');
      assert.equal(out.servers.find((s) => s.key === 'b').source, join(r, 'plugin.json'));
      assert.deepEqual(
        out.errors.map((e) => e.message),
        ['"mcpServers"[3]: MCP path must be a non-empty string']
      );
    }
  );
});

test('errors describe shape and location only, never configured values or source text', () => {
  const SECRET = 'SENTINEL-sk-9f8e7d6c5b4a';
  const files = {
    '.claude-plugin/plugin.json': {
      mcpServers: [
        `../${SECRET}/x.json`,
        `missing-${SECRET}.json`,
        { h: { type: 'http', headers: { Authorization: `Bearer ${SECRET}` } } },
        { t: { type: SECRET, url: `https://h/mcp?token=${SECRET}` } },
        { s: { args: [SECRET], env: { TOKEN: SECRET } } },
        { o: SECRET },
      ],
    },
  };
  withPlugin({ ...files, '.mcp.json': `{"a": {"command": "node", "args": ["${SECRET}"]}, ${SECRET}}` }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.equal(out.servers.length, 0);
    assert.equal(out.errors.length, 7);
    assert.ok(!JSON.stringify(out.errors).includes(SECRET), JSON.stringify(out.errors));
    assert.match(out.errors[0].message, /^invalid JSON at (line \d+ column \d+|position \d+)$/);
  });
  // Engines that quote the offending text in their parse error.
  withPlugin({ '.mcp.json': `${SECRET} {` }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.equal(out.errors.length, 1);
    assert.ok(!out.errors[0].message.includes(SECRET), out.errors[0].message);
  });
});

test('declarations are parsed once per unchanged file set; any change re-reads', () => {
  withPlugin({ 'plugin.json': { mcpServers: './m.json' }, 'm.json': { a: stdio('x') } }, (r) => {
    loadPluginMcpDeclarations(r);
    const before = pluginMcpDeclarationCacheStats();
    const first = loadPluginMcpDeclarations(r);
    discoverPluginMcp(r);
    const after = pluginMcpDeclarationCacheStats();
    assert.equal(after.misses, before.misses);
    assert.equal(after.hits, before.hits + 2);
    // Callers get their own copy.
    first.servers[0].config.command = 'mutated';
    assert.equal(loadPluginMcpDeclarations(r).servers[0].config.command, 'x');

    // A declared file changes: re-read.
    writeFileSync(join(r, 'm.json'), JSON.stringify({ a: stdio('changed-command') }));
    assert.equal(loadPluginMcpDeclarations(r).servers[0].config.command, 'changed-command');
    // A file that was absent appears: re-read.
    writeFileSync(join(r, '.mcp.json'), JSON.stringify({ extra: stdio('y') }));
    assert.deepEqual(keys(loadPluginMcpDeclarations(r)).sort(), ['a', 'extra']);
    // A higher-priority manifest appears: re-read.
    mkdirSync(join(r, '.codex-plugin'));
    writeFileSync(join(r, '.codex-plugin', 'plugin.json'), '{}');
    assert.equal(loadPluginMcpDeclarations(r).format, 'codex');
  });
});

test('no fallback: conventional script files are not executed or declared', () => {
  withPlugin({ 'plugin.json': {}, 'scripts/run-mcp.mjs': '', 'mcp/server.mjs': '', 'server.mjs': '' }, (r) => {
    assert.deepEqual(loadPluginMcpDeclarations(r).servers, []);
    assert.deepEqual(discoverPluginMcp(r), { mcpScript: null, mcpInline: false });
  });
  withPlugin({ 'plugin.json': { mcpServers: './server.mjs' }, 'server.mjs': 'process.exit(0)' }, (r) => {
    const out = loadPluginMcpDeclarations(r);
    assert.deepEqual(out.servers, []);
    assert.equal(out.errors.length, 1);
  });
});

test('resolveContainedPluginPath compares by segment', () => {
  const root = join(tmpdir(), 'mixdog-contain');
  assert.equal(resolveContainedPluginPath(root, '..foo/x.json'), join(root, '..foo', 'x.json'));
  assert.equal(resolveContainedPluginPath(root, '..'), null);
  assert.equal(resolveContainedPluginPath(root, '../x'), null);
  assert.equal(resolveContainedPluginPath(root, 'a/../../x'), null);
  assert.equal(resolveContainedPluginPath(root, '/abs'), null);
  assert.equal(resolveContainedPluginPath(root, 'a/..'), root);
});

test('the status adapter keeps its shape', () => {
  withPlugin({ '.mcp.json': { a: stdio('x') } }, (r) => {
    assert.deepEqual(discoverPluginMcp(r), { mcpScript: '.mcp.json', mcpInline: false });
  });
  withPlugin({ 'plugin.json': { mcpServers: './m.json' }, 'm.json': { a: stdio('x') } }, (r) =>
    assert.deepEqual(discoverPluginMcp(r), { mcpScript: './m.json', mcpInline: false })
  );
  withPlugin({ 'plugin.json': { mcpServers: { a: stdio('x') } } }, (r) => {
    assert.deepEqual(discoverPluginMcp(r), { mcpScript: null, mcpInline: true });
  });
});

const OFFICIAL = 'C:\\Project\\refs\\claude-plugins-official';
function findMcpJson(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findMcpJson(p, out);
    else if (e.name === '.mcp.json') out.push(p);
  }
  return out;
}

test('every official .mcp.json loads with zero errors', {
  skip: !existsSync(OFFICIAL) && `requires the claude-plugins-official checkout at ${OFFICIAL}`,
}, () => {
  const files = findMcpJson(OFFICIAL);
  assert.ok(files.length > 0);
  for (const file of files) {
    const out = loadPluginMcpDeclarations(dirname(file));
    assert.deepEqual(out.errors, [], file);
    assert.ok(out.servers.length > 0, file);
  }
});
