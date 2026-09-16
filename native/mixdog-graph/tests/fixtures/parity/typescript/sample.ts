// Parity fixture: every declaration shape the graph reports for TypeScript.
import type { Readable } from 'node:stream';
import { join } from 'node:path';
export { parse } from './parser.js';
const cjs = require('node:os');

export type Handler = (input: string) => void;
type Internal = Record<string, number>;

export interface Options {
  retries: number;
  run(): void;
}

interface Hidden {
  flag: boolean;
}

export enum Mode {
  Fast = 'fast',
  Slow = 'slow',
}

enum Internals {
  A,
}

export const LIMIT = 10;
export let counter = 0;
const local = join('a', 'b');
var legacy = cjs;

export function resolveAll(paths: string[]): string[] {
  function nested(path: string): string {
    return path;
  }
  return paths.map(nested);
}

export declare function ambient(input: string): void;

export abstract class Base {
  abstract run(): void;

  protected helper(): number {
    return 1;
  }
}

export class Runner extends Base {
  constructor(private readonly options: Options) {
    super();
  }

  run(): void {
    void this.options;
  }

  #secret(): void {}
}

export namespace Shapes {
  export const kind = 'shape';
}

declare module 'untyped-package';

const arrow = (value: number): number => value + 1;
const expression = function namedExpression(stream: Readable) {
  return stream;
};

function* iterate(values: number[]) {
  yield* values;
}
