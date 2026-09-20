import { readFileSync } from 'node:fs';
function tryRead(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}
export { tryRead };
