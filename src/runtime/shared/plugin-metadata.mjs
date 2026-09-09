// Display-only manifest metadata, shared by registry and session status.
// Keep malformed values empty instead of leaking "[object Object]" into UI.
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function authorText(value) {
  if (typeof value === 'string') return value.trim();
  const author = object(value);
  const email = text(author.email);
  return [
    text(author.name),
    email ? `<${email}>` : '',
    text(author.url),
  ].filter(Boolean).join(' ');
}

export function pluginMetadata(value) {
  const manifest = object(value);
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [manifest.keywords];
  return {
    author: authorText(manifest.author),
    homepage: text(manifest.homepage),
    repository: text(manifest.repository) || text(object(manifest.repository).url),
    license: text(manifest.license) || text(object(manifest.license).type),
    keywords: keywords.map(text).filter(Boolean),
  };
}
