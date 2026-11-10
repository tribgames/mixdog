// A module-resolution hook: `local-files.ts` loaded with `?posix` gets `node:path/posix` where it imports `node:path`. Node's own code then
// runs with the POSIX rules it has on a POSIX host (`path` is `path.posix` there), so the POSIX recording needs no POSIX machine.
export async function resolve(specifier, context, next) {
  if ((specifier === 'node:path' || specifier === 'path') && context.parentURL?.includes('local-files.ts?posix')) {
    return { url: 'node:path/posix', shortCircuit: true };
  }
  return next(specifier, context);
}