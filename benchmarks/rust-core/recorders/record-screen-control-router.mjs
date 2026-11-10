#!/usr/bin/env node
// Node's `ScreenInputRouter` (apps/desktop/src/main/remote-screen/screen-input-router.ts): the one serialized path
// every screen input, backend switch and release of a phone's session takes to a desktop. Each scenario is a script of
// steps — switch backend (with hooks), dispatch a plan, dispatch a key combo, release all, cancel, abandon, close or
// open a backend's gate, move a backend's reported desktop or reachability, settle, await a call — run against two
// fake backends (`desktop`, `secure`) that only record what they were sent. The golden holds the script and the whole
// trace Node gave: every backend send (start and end), every `allowed` evaluation with its answer, every hook, every
// dropped-press report and every call's completion in order, and the final state (active backend, held, sent).
// Rust's router must replay each script to the same trace.
//
// The fakes never reach a desktop: a backend is a list the commands are pushed on.
//
//   (cd <tree>/apps/desktop && node --import tsx <repo>/benchmarks/rust-core/recorders/record-screen-control-router.mjs --tree <tree>)
import { checkpoint, importTs, openTree, record } from './record-screen-control-lib.mjs';

const { tree, identity, only } = openTree();
const { ScreenInputRouter } = await importTs(tree, 'apps/desktop/src/main/remote-screen/screen-input-router.ts');

const keyDown = (vk, scan = 0x1e, extended = false) => ({ op: 'key', vk, scan, extended, down: true });
const keyUp = (vk, scan = 0x1e, extended = false) => ({ op: 'key', vk, scan, extended, down: false });
const text = (value) => ({ op: 'text', text: value });
const DEFAULT_1 = { session: 1, desktop: 'default' };
const WINLOGON_1 = { session: 1, desktop: 'winlogon' };
const CTRL = keyDown(0xa2, 0x1d);
const SHIFT = keyDown(0xa0, 0x2a);
const C = keyDown(0x43, 0x2e);
const A = keyDown(0x41);
const B = keyDown(0x42, 0x30);
const LEFT_CTRL = keyDown(0xa2, 0x1d);
const RIGHT_ALT = keyDown(0xa5, 0x38, true);

// Steps. `await` settles first and demands the call finished: a script that waits on a call nothing can finish is wrong.
const sw = (to, hooks, as = 'switch') => [{ op: 'switch', as, to, ...(hooks ? { hooks } : {}) }, { op: 'await', call: as }];
const dispatch = (as, commands, allowed = 'always') => ({ op: 'dispatch', as, commands, allowed });
const keys = (as, commands, allowed = 'always') => ({ op: 'dispatchKeys', as, commands, allowed });
const done = (as) => ({ op: 'await', call: as });
const run = (as, commands, allowed = 'always') => [dispatch(as, commands, allowed), done(as)];
const release = (as = 'release') => [{ op: 'releaseAll', as }, done(as)];
const gate = (backend, mode) => ({ op: 'gate', backend, mode });
const where = (backend, value) => ({ op: 'identity', backend, value });
const reach = (backend, value) => ({ op: 'reachable', backend, value });
const settle = { op: 'settle' };

const SCENARIOS = [
  {
    name: 'a key combo is pressed in order and released in reverse, as one step',
    steps: [
      ...sw('desktop'),
      keys('combo', [CTRL, SHIFT, C]),
      dispatch('after', [A]),
      done('combo'),
      done('after'),
      ...release('release'),
    ],
  },
  {
    name: 'a combo leaves a modifier the phone holds held',
    steps: [...sw('desktop'), ...run('ctrl', [CTRL]), keys('combo', [CTRL, C]), done('combo')],
  },
  {
    name: 'control lost mid-combo presses nothing more, and what it pressed is released',
    steps: [...sw('desktop'), keys('combo', [CTRL, SHIFT, C], { kind: 'sent-count-is', backend: 'desktop', count: 0 }), done('combo')],
  },
  {
    name: 'a combo whose desktop changes mid-way sends nothing to the new one: its presses are dropped',
    steps: [
      ...sw('desktop'),
      keys('combo', [CTRL, C], { kind: 'move-at-sent', backend: 'desktop', count: 1, to: { session: 2, desktop: 'default' } }),
      done('combo'),
    ],
  },
  {
    name: 'a cancel during a combo still releases what it pressed',
    steps: [...sw('desktop'), gate('desktop', 'close'), keys('combo', [CTRL, C]), settle, { op: 'cancel' }, gate('desktop', 'open'), done('combo')],
  },
  {
    name: 'releaseAll lifts every held press once and is idempotent',
    steps: [
      ...sw('desktop'),
      ...run('key', [A]),
      ...run('button', [{ op: 'button', button: 'left', down: true, at: { x: 1, y: 1 } }]),
      ...release('release-1'),
      ...release('release-2'),
    ],
  },
  { name: 'an up for a press this backend does not own is skipped', steps: [...sw('desktop'), ...run('up', [keyUp(0x41)])] },
  {
    name: 'a button up without a position lifts the button pressed at one',
    steps: [
      ...sw('desktop'),
      ...run('down', [{ op: 'button', button: 'right', down: true, at: { x: 5, y: 6 } }]),
      ...run('up', [{ op: 'button', button: 'right', down: false }]),
      ...release(),
    ],
  },
  {
    name: 'a backend switch releases the old backend’s presses through it, before the switch',
    steps: [...sw('desktop'), ...run('ctrl', [CTRL]), ...sw('secure', { before: 'observe', after: 'observe' }, 'to-secure')],
  },
  {
    name: 'a press its backend can’t release at the switch is dropped and counted, never carried',
    steps: [
      ...sw('desktop'),
      ...run('a', [A]),
      reach('desktop', false),
      ...sw('secure', undefined, 'to-secure'),
      reach('desktop', true),
      ...sw('desktop', undefined, 'back'),
      ...release(),
    ],
  },
  {
    name: 'cancel drops queued input but the final release runs after the in-flight command',
    steps: [
      ...sw('desktop'),
      gate('desktop', 'close'),
      dispatch('in-flight', [A]),
      settle,
      dispatch('queued', [B]),
      { op: 'cancel' },
      { op: 'releaseAll', as: 'release' },
      gate('desktop', 'open'),
      done('in-flight'),
      done('queued'),
      done('release'),
    ],
  },
  {
    name: 'the gate is re-read between the commands of one plan',
    steps: [...sw('desktop'), ...run('plan', [{ op: 'move', x: 1, y: 1 }, A], { kind: 'first-checks', count: 2 })],
  },
  {
    name: 'text is refused while a shortcut modifier is held, allowed with Shift',
    steps: [
      ...sw('desktop'),
      ...run('shift', [SHIFT]),
      ...run('text-with-shift', [text('a')]),
      ...run('ctrl', [CTRL]),
      ...run('text-with-ctrl', [text('a')]),
      ...run('ctrl-up', [keyUp(0xa2, 0x1d)]),
      ...run('text-after-ctrl', [text('a')]),
    ],
  },
  {
    name: 'AltGr text: the session-held AltGr keys are lifted around the text and pressed again',
    steps: [...sw('desktop'), ...run('altgr', [LEFT_CTRL, RIGHT_ALT]), ...run('text', [text('€')]), ...release()],
  },
  {
    name: 'Right Alt alone counts as AltGr',
    steps: [...sw('desktop'), ...run('alt', [RIGHT_ALT]), ...run('text', [text('@')])],
  },
  {
    name: 'Ctrl+Left Alt stays a shortcut: its text is refused and sends nothing',
    steps: [...sw('desktop'), ...run('ctrl-alt', [keyDown(0xa2, 0x1d), keyDown(0xa4, 0x38)]), ...run('text', [text('a')])],
  },
  {
    name: 'AltGr with the Windows key stays a shortcut',
    steps: [...sw('desktop'), ...run('altgr-win', [RIGHT_ALT, keyDown(0x5b, 0x5b, true)]), ...run('text', [text('a')])],
  },
  {
    name: 'AltGr keys are pressed again even when the text itself fails',
    steps: [...sw('desktop'), ...run('alt', [RIGHT_ALT]), { op: 'failText', backend: 'desktop', value: true }, ...run('text', [text('x')])],
  },
  {
    name: 'abandon cuts an in-flight send and every later one; the releases are dropped and counted',
    steps: [
      ...sw('desktop'),
      ...run('a', [A]),
      gate('desktop', 'hang'),
      dispatch('hung', [B]),
      settle,
      { op: 'releaseAll', as: 'release' },
      { op: 'abandon' },
      done('hung'),
      done('release'),
      ...run('after-abandon', [{ op: 'move', x: 1, y: 1 }]),
    ],
  },
  {
    name: 'a cancel during the AltGr lift: no text, no re-press, nothing left held',
    steps: [
      ...sw('desktop'),
      ...run('altgr', [LEFT_CTRL, RIGHT_ALT]),
      gate('desktop', 'close'),
      dispatch('typing', [text('€')]),
      settle,
      { op: 'cancel' },
      gate('desktop', 'open'),
      done('typing'),
      ...release(),
    ],
  },
  {
    name: 'the backend moves to another session during the AltGr lift: no further lift, text or re-press there',
    steps: [
      ...sw('desktop'),
      ...run('altgr', [LEFT_CTRL, RIGHT_ALT]),
      gate('desktop', 'close'),
      dispatch('typing', [text('€')]),
      settle,
      where('desktop', { session: 2, desktop: 'default' }),
      gate('desktop', 'open'),
      done('typing'),
      ...release(),
    ],
  },
  {
    name: 'a revoke after the text, before the re-press: AltGr is never pressed again',
    steps: [...sw('desktop'), ...run('alt', [RIGHT_ALT]), ...run('typing', [text('@')], { kind: 'no-text-sent', backend: 'desktop' }), ...release()],
  },
  {
    name: 'a revoke before the text: the lifted keys stay up and the text is not sent',
    steps: [...sw('desktop'), ...run('alt', [RIGHT_ALT]), ...run('typing', [text('@')], { kind: 'sent-count-is', backend: 'desktop', count: 1 })],
  },
  {
    name: 'no key-up reaches another session: it is dropped, not sent later',
    steps: [
      ...sw('secure'),
      ...run('a', [A]),
      where('secure', { session: 2, desktop: 'winlogon' }),
      ...release('release-elsewhere'),
      where('secure', WINLOGON_1),
      ...release('release-back'),
    ],
  },
  {
    name: 'no key-up reaches another desktop: it is dropped, not sent later',
    steps: [
      ...sw('secure'),
      ...run('a', [A]),
      where('secure', { session: 1, desktop: 'default' }),
      ...release('release-elsewhere'),
      where('secure', WINLOGON_1),
      ...release('release-back'),
    ],
  },
  {
    name: 'each origin’s press of the same key is released only on its own desktop',
    steps: [
      ...sw('secure'),
      ...run('a-winlogon', [A]),
      where('secure', { session: 1, desktop: 'locked' }),
      ...run('a-locked', [A]),
      ...run('lift-a', [keyUp(0x41)]),
      ...release('release-on-locked'),
    ],
  },
  {
    name: 'no press is made where the landing desktop is unknown',
    steps: [...sw('desktop'), where('desktop', null), ...run('a', [A])],
  },
  {
    name: 'abandon also cuts a switch hook that never settles',
    steps: [{ op: 'switch', as: 'switching', to: 'secure', hooks: { before: 'never' } }, settle, { op: 'abandon' }, done('switching'), ...release()],
  },
  {
    name: 'a failing switch hook does not stop the switch',
    steps: [{ op: 'switch', as: 'switching', to: 'secure', hooks: { before: 'throws', after: 'observe' } }, done('switching'), ...run('a', [A])],
  },
  {
    name: 'a switch to no backend releases first, then input is rejected',
    steps: [...sw('desktop'), ...run('a', [A]), ...sw(null, undefined, 'to-none'), ...run('move', [{ op: 'move', x: 1, y: 1 }])],
  },
  {
    name: 'input before any backend is chosen is rejected',
    steps: [...run('move', [{ op: 'move', x: 1, y: 1 }]), ...run('combo', [CTRL]), ...release()],
  },
  {
    name: 'the desktop’s presses are lifted through it when the secure desktop takes over, and the secure backend gets only its own',
    steps: [
      ...sw('desktop'),
      ...run('down', [{ op: 'button', button: 'left', down: true, at: { x: 10, y: 20 } }, keyDown(0x10, 0x2a)]),
      ...sw('secure', { before: 'observe', after: 'observe' }, 'to-secure'),
      ...run('secure-down', [{ op: 'button', button: 'left', down: true, at: { x: 30, y: 40 } }, C]),
      ...sw('desktop', { before: 'observe', after: 'observe' }, 'back'),
      ...release(),
    ],
  },
  {
    name: 'a plan that fails on the backend is rejected and keeps the press it made held for the release',
    steps: [...sw('desktop'), reach('desktop', false), ...run('a', [A]), reach('desktop', true), ...release()],
  },
];

// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));

async function play(scenario) {
  const log = [];
  const fakes = {
    desktop: { sent: [], reachable: true, gate: null, identity: DEFAULT_1, failText: false },
    secure: { sent: [], reachable: true, gate: null, identity: WINLOGON_1, failText: false },
  };
  const backend = (name) => ({
    identity: () => fakes[name].identity,
    async send(command) {
      const fake = fakes[name];
      log.push({ ev: 'send', backend: name, phase: 'start', command: clone(command) });
      if (fake.gate) await fake.gate.promise;
      if (!fake.reachable || (fake.failText && command.op === 'text')) {
        log.push({ ev: 'send', backend: name, phase: 'fail', command: clone(command) });
        throw new Error('backend refused');
      }
      fake.sent.push(command);
      log.push({ ev: 'send', backend: name, phase: 'ok', command: clone(command) });
    },
  });
  const router = new ScreenInputRouter({ desktop: backend('desktop'), secure: backend('secure') }, (name, count) =>
    log.push({ ev: 'dropped', backend: name, count })
  );
  const calls = new Map();
  const allowedFor = (call, policy) => {
    let checks = 0;
    const answer = () => {
      checks += 1;
      const p = typeof policy === 'string' ? { kind: policy } : policy;
      const fake = fakes[p.backend];
      switch (p.kind) {
        case 'always':
          return true;
        case 'sent-count-is':
          return fake.sent.length === p.count;
        case 'first-checks':
          return checks <= p.count;
        case 'no-text-sent':
          return !fake.sent.some((command) => command.op === 'text');
        case 'move-at-sent':
          if (fake.sent.length === p.count) fake.identity = p.to;
          return true;
        default:
          throw new Error(`unknown policy ${p.kind}`);
      }
    };
    return () => {
      const value = answer();
      log.push({ ev: 'allowed', call, n: checks, value });
      return value;
    };
  };
  const hookFor = (call, name, kind) => {
    if (!kind) return undefined;
    return async () => {
      log.push({ ev: 'hook', call, name, active: router.activeBackend(), lastDesktopSent: clone(fakes.desktop.sent.at(-1) ?? null), lastSecureSent: clone(fakes.secure.sent.at(-1) ?? null) });
      if (kind === 'never') await new Promise(() => {});
      if (kind === 'throws') throw new Error('hook failed');
    };
  };
  const start = (as, promise) => {
    const entry = { done: false };
    calls.set(as, entry);
    promise.then((value) => {
      entry.done = true;
      log.push({ ev: 'done', call: as, value: value ?? null });
    });
  };
  for (const step of scenario.steps) {
    switch (step.op) {
      case 'switch':
        start(
          step.as,
          router.switchTo(step.to, { before: hookFor(step.as, 'before', step.hooks?.before), after: hookFor(step.as, 'after', step.hooks?.after) })
        );
        break;
      case 'dispatch':
        start(step.as, router.dispatch(clone(step.commands), allowedFor(step.as, step.allowed)));
        break;
      case 'dispatchKeys':
        start(step.as, router.dispatchKeys(clone(step.commands), allowedFor(step.as, step.allowed)));
        break;
      case 'releaseAll':
        start(step.as, router.releaseAll());
        break;
      case 'cancel':
        router.cancel();
        log.push({ ev: 'cancel' });
        break;
      case 'abandon':
        router.abandon();
        log.push({ ev: 'abandon' });
        break;
      case 'gate': {
        const fake = fakes[step.backend];
        if (step.mode === 'open') {
          const open = fake.gate;
          fake.gate = null;
          open?.resolve();
        } else {
          let resolve;
          const promise = new Promise((r) => (resolve = r));
          fake.gate = { promise, resolve: step.mode === 'hang' ? () => {} : resolve };
        }
        break;
      }
      case 'identity':
        fakes[step.backend].identity = step.value;
        break;
      case 'reachable':
        fakes[step.backend].reachable = step.value;
        break;
      case 'failText':
        fakes[step.backend].failText = step.value;
        break;
      case 'settle':
        await checkpoint();
        break;
      case 'await':
        await checkpoint();
        if (!calls.get(step.call)?.done) throw new Error(`${scenario.name}: ${step.call} did not finish`);
        break;
      default:
        throw new Error(`unknown step ${step.op}`);
    }
  }
  await checkpoint();
  return {
    name: scenario.name,
    backends: { desktop: DEFAULT_1, secure: WINLOGON_1 },
    steps: scenario.steps,
    trace: log,
    final: { active: router.activeBackend(), holds: router.holdsInput(), sent: { desktop: fakes.desktop.sent, secure: fakes.secure.sent } },
  };
}

await record({
  sub: 'router',
  recorderUrl: import.meta.url,
  identity,
  only,
  entries: SCENARIOS,
  play,
  files: (scenarios) => ({ 'scenarios.json': { scenarios } }),
  committed: (read) => read('scenarios.json').scenarios,
});
process.exit(process.exitCode ?? 0);
