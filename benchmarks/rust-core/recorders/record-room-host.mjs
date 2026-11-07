#!/usr/bin/env node
// Golden twin of the room host registry (`registerAgentRoomHost` / `agentRoomHost()`, runtime/shared/agent-room-host.mjs) as the home delivery
// uses it (`agentRoomHost().relay(sessionId, prompt, options)`, agent-home-delivery.mjs:1206). Node's real module runs a script of attach and
// detach steps; each step records what it answered: the active host's name, the relay the active host received, or the error thrown when no
// desktop app is attached. Hosts are stand-ins that answer `relay` with their own name and the arguments they were given.
//
// The module is dependency-free and reads no user directory; the usual temp dirs are set before it loads anyway.
//   node benchmarks/rust-core/recorders/record-room-host.mjs --tree <dir> [--out <dir>]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolve(cli.get('tree') ?? '.');
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'room-host');
const base = mkdtempSync(join(tmpdir(), 'room-host-'));
const userDirs = { HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', MIXDOG_HOME: 'mixdog-home' };
for (const [name, dir] of Object.entries(userDirs)) {
  mkdirSync(join(base, dir), { recursive: true });
  process.env[name] = join(base, dir);
}
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';

const { registerAgentRoomHost, agentRoomHost } = await importFrom(tree, 'src/runtime/shared/agent-room-host.mjs');

const host = (name) => ({
  name,
  relay: (sessionId, prompt, options) => ({ host: name, sessionId, prompt, id: options?.id ?? '', hop: options?.hop ?? 0 }),
});

const RELAY = { sessionId: 'room01::bench', prompt: 'REPORT: done', options: { id: 'awake_1', hop: 2 } };

// Each step: register a host under a handle, drop a handle (twice is allowed), ask for the active host, relay through it.
const script = [
  { op: 'active' },
  { op: 'relay', ...RELAY },
  { op: 'register', host: 'A', as: 'a1' },
  { op: 'active' },
  { op: 'relay', ...RELAY },
  { op: 'register', host: 'B', as: 'b1' },
  { op: 'active' },
  { op: 'relay', ...RELAY },
  { op: 'register', host: 'A', as: 'a2' },
  { op: 'active' },
  { op: 'unregister', as: 'b1' },
  { op: 'active' },
  { op: 'unregister', as: 'a2' },
  { op: 'active' },
  { op: 'unregister', as: 'a2' },
  { op: 'active' },
  { op: 'register', host: 'B', as: 'b2' },
  { op: 'unregister', as: 'a1' },
  { op: 'active' },
  { op: 'relay', ...RELAY, options: { id: '', hop: 0 } },
  { op: 'unregister', as: 'b2' },
  { op: 'active' },
  { op: 'relay', ...RELAY },
  { op: 'unregister', as: 'b2' },
  { op: 'register', host: 'C', as: 'c1' },
  { op: 'relay', ...RELAY },
  { op: 'unregister', as: 'c1' },
  { op: 'relay', ...RELAY },
];

const handles = new Map();
const steps = script.map((step) => {
  let answer = {};
  try {
    if (step.op === 'register') {
      handles.set(step.as, registerAgentRoomHost(host(step.host)));
    } else if (step.op === 'unregister') {
      handles.get(step.as)();
    } else if (step.op === 'active') {
      answer = { host: agentRoomHost().name };
    } else {
      answer = { relayed: agentRoomHost().relay(step.sessionId, step.prompt, step.options) };
    }
  } catch (error) {
    answer = { error: { name: error.name, message: error.message } };
  }
  return { ...step, answer };
});

writeJson(join(outDir, 'room-host-twin.json'), {
  domain: 'room-host-twin',
  recorder: 'benchmarks/rust-core/recorders/record-room-host.mjs',
  steps,
});
writeSetManifest(outDir, {
  set: 'room-host',
  recorder: 'benchmarks/rust-core/recorders/record-room-host.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-host.mjs --tree <tree>',
  identityTree: tree,
});
