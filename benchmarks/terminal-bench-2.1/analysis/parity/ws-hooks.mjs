// Module-resolution hook: `ws` resolves to the recorder (ws-recorder.mjs), so the Node providers' socket opens
// against the recorded stand-in instead of the network. Registered by node-wire-capture.mjs before any provider loads.
let recorder;

export async function initialize({ target }) {
  recorder = target;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws') return { url: recorder, shortCircuit: true };
  return nextResolve(specifier, context);
}
