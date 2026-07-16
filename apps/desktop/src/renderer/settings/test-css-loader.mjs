export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: '', shortCircuit: true };
  }
  return nextLoad(url, context);
}
