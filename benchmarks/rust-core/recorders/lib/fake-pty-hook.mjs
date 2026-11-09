// Loader hook: the Node terminal manager's PTY module is the scripted one in fake-pty.mjs.
const FAKE = new URL('./fake-pty.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@homebridge/node-pty-prebuilt-multiarch') return { url: FAKE, shortCircuit: true };
  return next(specifier, context);
}
