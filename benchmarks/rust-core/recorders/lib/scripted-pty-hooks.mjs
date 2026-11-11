// Resolve hook (module.register) that gives the desktop's terminal manager scripted-pty.mjs in place of node-pty: its dynamic
// `import('@homebridge/node-pty-prebuilt-multiarch')` (terminal-manager.ts loadPtyBindings) is the only way the PTY enters.
const PTY = '@homebridge/node-pty-prebuilt-multiarch';

export async function resolve(specifier, context, next) {
  if (specifier === PTY) return { url: new URL('./scripted-pty.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
