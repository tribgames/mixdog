// Parity fixture: every declaration shape the graph reports for JavaScript.
import { readFile } from 'node:fs/promises';
import defaultExport from './dep.js';
export { helper } from './helper.js';
const legacy = require('node:path');

export const CONFIG = { retries: 2 };
export let mutableState = null;
var legacyBinding = 1;

export function loadAll(paths) {
  // nested declarations still report
  function inner(path) {
    return path;
  }
  class Inner {
    run() {
      return inner(paths[0]);
    }
  }
  return new Inner().run();
}

export class Store {
  constructor(name) {
    this.name = name;
  }

  async read(key) {
    const mod = await import('./lazy.js');
    return mod.read(key);
  }

  #hidden() {
    return this.name;
  }
}

class Plain {
  static create() {
    return new Plain();
  }
}

const Anonymous = class Named {
  value() {
    return 1;
  }
};

const generated = function generatedName() {
  return legacy;
};

function* walk(items) {
  yield* items;
}

export default Store;
