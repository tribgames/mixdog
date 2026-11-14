// The id a window is known by to the core (sent as `Mixdog-Window`): a UUID per webContents, stable for its life,
// never reused (an Electron webContents id can be, and the core can outlive this process).
import { randomUUID } from 'node:crypto';

const ids = new WeakMap<object, string>();

export function windowIdFor(webContents: object): string {
  let id = ids.get(webContents);
  if (id === undefined) {
    id = randomUUID();
    ids.set(webContents, id);
  }
  return id;
}
