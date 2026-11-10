import { cleanString } from './clean.mjs';
import { isPlainObject } from './object.mjs';

// Display-only manifest metadata, shared by registry and session status.
// Keep malformed values empty instead of leaking "[object Object]" into UI.
function object(value) {
  return isPlainObject(value) ? value : {};
}

function authorText(value) {
  if (typeof value === 'string') return value.trim();
  const author = object(value);
  const email = cleanString(author.email);
  return [cleanString(author.name), email ? `<${email}>` : '', cleanString(author.url)].filter(Boolean).join(' ');
}

export function pluginMetadata(value) {
  const manifest = object(value);
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [manifest.keywords];
  return {
    author: authorText(manifest.author),
    homepage: cleanString(manifest.homepage),
    repository: cleanString(manifest.repository) || cleanString(object(manifest.repository).url),
    license: cleanString(manifest.license) || cleanString(object(manifest.license).type),
    keywords: keywords.map(cleanString).filter(Boolean),
  };
}
