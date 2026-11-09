// A paired phone with the terminal adapter installed, against the world's scripted protocol core (benchmarks/rust-core/recorders/lib/
// phone-world.mjs). The shim keeps module-level state: one world per test file (per process).
import { readFileSync } from 'node:fs';
import { createPhoneWorld, protocolDialect } from '../../../../benchmarks/rust-core/recorders/lib/phone-world.mjs';

const section = (name, value, revision) => ({ section: name, key: null, revision, value });

export async function adapterWorld() {
  const repo = new URL('../../../../', import.meta.url);
  const options = JSON.parse(readFileSync(new URL('packages/protocol-client/conformance/options.json', repo), 'utf8'));
  const version = JSON.parse(readFileSync(new URL('apps/desktop/package.json', repo), 'utf8')).version;
  const base = protocolDialect({ ...options.initializeResult, serverVersion: version });
  const frames = [];
  let leg = null;
  const dialect = {
    ...base,
    onFrame(current, frame, log) {
      leg = current;
      frames.push(frame);
      // The core's answer to an ensure names the asking connection; the rest is the world's.
      if (frame.method === 'terminal/ensure') return void current.toPhone({ id: frame.id, result: { id: frame.params.tabId ?? 't', replay: '', client: 'me', sizeOwner: null } });
      return base.onFrame(current, frame, log);
    },
  };
  const world = await createPhoneWorld({ tree: decodeURIComponent(repo.pathname.slice(1)), dialect, paired: true });
  const { adapter } = await import('./remote-protocol-terminal.ts');
  const { installPhoneShim } = await import('./remote-shim-boot.ts');
  installPhoneShim([adapter]);
  await world.waitFor((e) => e.ev === 'socket');
  await world.accept();
  await world.until(() => frames.some((f) => f.method === 'app/subscribe'));
  await world.advance(0);
  let seq = 0;
  let revision = 0;
  const push = (method, params) => leg.toPhone({ method, params, feed: { id: 'app', epoch: 'e', seq: (seq += 1) } });
  console.error('FRAMES', frames.map((f) => f.method).join(','));
  await push('app/snapshot', { sections: [] });
  await world.advance(0);
  return {
    world,
    api: globalThis.window.mixdogDesktop,
    frames,
    push,
    /** A section change of the app feed, as the core publishes it. */
    setSection: async (name, value) => {
      await push(`${name === 'terminalTabs' ? 'terminal/tabs' : 'terminal/activity'}/updated`, section(name, value, (revision += 1)));
      await world.advance(0);
    },
    settle: () => world.advance(0),
  };
}
