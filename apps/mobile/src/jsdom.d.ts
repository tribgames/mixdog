// Test-only: jsdom ships no types and the tests use only this slice.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    window: Window & typeof globalThis;
  }
}
