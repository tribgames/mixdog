// The id a window is known by to the core (sent as `Mixdog-Window`): one per webContents, stable for its life,
// never reused inside a process (an Electron webContents id can be).
const ids = new WeakMap<object, string>();
let next = 1;

export function windowIdFor(webContents: object): string {
  let id = ids.get(webContents);
  if (id === undefined) {
    id = `w${next++}`;
    ids.set(webContents, id);
  }
  return id;
}
