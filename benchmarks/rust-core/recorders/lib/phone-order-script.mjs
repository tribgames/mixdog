// The script of calls of different feature groups arriving on one phone connection (unit PH-2, D11): which of them may start while an
// earlier one is unfinished. One script drives the Node recording (record-phone-order.mjs: Node's own relay dispatch and call queue at
// b6f10295a) and the replay against the phone's router (apps/desktop/src/renderer/remote-protocol-order.test.mjs); both play it
// with `play`, so the two traces are made of the same steps.
//
// A call is a Node method with params; its handler does nothing but note that it started, wait for the script to release it, and note
// that it ended. A step is `['send', name]` (the call arrives), `['release', name]` (the script lets that call's handler finish) or
// `['fire', name]` (the call arrives and the page does not wait for its answer), `['ready']` (the phone's connection becomes ready: a
// step only the replay has, Node has no readiness, so the recorder never receives it), `['settle']` (everything that can start has started: the world has no timer or I/O, so every continuation is a microtask and one turn
// of the event loop runs them all - the turn is a barrier, not a duration).
const P = 'D:\\proj';

/** The calls by name. Each Node method appears once per script, so a handler knows its call by its method. */
export const orderCalls = {
  write: { method: 'writeProjectFile', params: [P, 'a.txt', 'new\n', 'old\n', null, null] },
  list: { method: 'listProjectDir', params: [P, ''] },
  stat: { method: 'statProjectFile', params: [P, 'a.txt', null] },
  rename: { method: 'renameSession', params: ['s1', 'A title'] },
  archive: { method: 'setSessionArchived', params: ['s1', true] },
  snapshot: { method: 'getSnapshot', params: ['s1'] },
  usage: { method: 'readCapabilities', params: [[{ capability: 'getUsageDashboard', args: [] }]] },
  // The terminal lane's six methods. A keystroke and a size are sent, not awaited (instant: the handler ends where it starts, there
  // is nothing for the script to hold); the others are awaited by the page.
  termEnsure: { method: 'termEnsure', params: ['term_o1', P, null] },
  termAttach: { method: 'termAttach', params: ['term_o1'] },
  termProfiles: { method: 'termProfiles', params: [] },
  termWrite: { method: 'termWrite', params: ['term_o1', 'x'], instant: true },
  termResize: { method: 'termResize', params: ['term_o1', 80, 24, true], instant: true },
  termDispose: { method: 'termDispose', params: ['term_o1'] },
};

const send = (name) => ['send', name];
const fire = (name) => ['fire', name];
const release = (name) => ['release', name];
const settle = ['settle'];

export const orderScenarios = {
  // A file write is unfinished: a chat mutation arriving after it waits, and so does everything behind that.
  'a file write, then chat mutations and reads': [
    send('write'), send('rename'), send('list'), send('snapshot'), send('archive'), send('stat'), settle,
    release('write'), settle, release('rename'), settle, release('list'), release('snapshot'), settle, release('archive'), settle, release('stat'), settle,
  ],
  // The other way round: a chat mutation is unfinished, a file write after it waits.
  'a chat mutation, then a file write and reads': [
    send('rename'), send('write'), send('list'), send('snapshot'), settle,
    release('rename'), settle, release('write'), settle, release('list'), release('snapshot'), settle,
  ],
  // Reads of both groups overlap; a mutation of either waits for all of them.
  'reads of both groups overlap, a mutation waits for them': [
    send('list'), send('snapshot'), send('stat'), send('archive'), send('write'), settle,
    release('list'), settle, release('snapshot'), release('stat'), settle, release('archive'), settle, release('write'), settle,
  ],
  // A call the page waits for, then one it does not (`fire`): the later one does not overtake the earlier. Node receives both as frames
  // and queues each on receipt; the phone's router may still be waiting for its connection (readiness), which Node has no step for.
  'a call, then a fire, of chat mutations': [
    send('rename'), fire('archive'), settle,
    release('rename'), settle, release('archive'), settle,
  ],
  'a fire, then a call, of chat mutations': [
    fire('archive'), send('rename'), settle,
    release('archive'), settle, release('rename'), settle,
  ],
  'a file write call, then a chat mutation fire, then a read call': [
    send('write'), fire('archive'), send('snapshot'), settle,
    release('write'), settle, release('archive'), settle, release('snapshot'), settle,
  ],
  // The terminal lane runs apart from the general lane: a file write, a chat mutation or a read unfinished does not hold a terminal call,
  // and an unfinished terminal call does not hold theirs.
  'terminal calls beside a file write and a chat mutation': [
    send('write'), send('termEnsure'), fire('termWrite'), send('rename'), send('termProfiles'), send('snapshot'), settle,
    release('termEnsure'), settle, release('termProfiles'), settle, release('write'), settle, release('rename'), settle, release('snapshot'), settle,
  ],
  // The lane is one at a time, in arrival order: a keystroke and a size wait for the 	ermEnsure before them, a dispose for them all.
  'terminal lifecycle in one lane, in arrival order': [
    send('termEnsure'), fire('termWrite'), fire('termResize'), send('termDispose'), send('termAttach'), send('termProfiles'), settle,
    release('termEnsure'), settle, release('termDispose'), settle, release('termAttach'), settle, release('termProfiles'), settle,
  ],
  // A usage sweep (a slow read, named by its capability) observes the file write before it, not the chat mutation after it.
  'a slow capability read observes the earlier file write, a later chat mutation waits for the write': [
    send('write'), send('usage'), send('archive'), send('snapshot'), settle,
    release('write'), settle, release('usage'), release('archive'), settle, release('snapshot'), settle,
  ],
};

/**
 * Plays one scenario. `driver.send(name)` makes the call arrive and returns a promise of its answer; `driver.gate(name)` is what the
 * call's handler awaits. The trace: the events in the order they happened, and each call's answer.
 */
export async function play(steps, driver) {
  const events = [];
  const answers = {};
  const gates = Object.fromEntries(Object.keys(orderCalls).map((name) => [name, Promise.withResolvers()]));
  driver.begin({
    started: (name) => events.push(['start', name]),
    gate: async (name) => {
      if (!orderCalls[name].instant) await gates[name].promise;
      events.push(['end', name]);
    },
  });
  const running = [];
  for (const [op, name] of steps) {
    if (op === 'send') {
      running.push(
        Promise.resolve(driver.send(name)).then(
          () => (answers[name] = 'ok'),
          (error) => (answers[name] = error.message)
        )
      );
    } else if (op === 'fire') {
      // The page does not wait for a fired call's answer: the trace holds its events only.
      running.push(Promise.resolve(driver.fire(name)).catch(() => undefined));
    } else if (op === 'ready') driver.ready?.();
    else if (op === 'release') gates[name].resolve();
    else await new Promise((done) => setImmediate(done));
  }
  await Promise.all(running);
  return { events, answers };
}
