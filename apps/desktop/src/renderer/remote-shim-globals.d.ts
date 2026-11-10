// The protocol client yields its fold with setImmediate where it exists (Node); the page's lib has no such global.
declare function setImmediate(callback: () => void): unknown;
