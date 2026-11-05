import type { Json } from './api.ts';

/** A JSON object as the fold reads and builds rows. */
export type Obj = { [k: string]: Json };
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asObj = (v: unknown): Obj => (isObj(v) ? v : {});
